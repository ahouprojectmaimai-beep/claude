import { describe, expect, it } from "vitest";
import {
  BookingError, cancelBooking, cleanupPending, createBooking, eventTitle, getAvailability, getBooking, getBookingByToken,
  rescheduleBooking,
} from "../src/lib/booking.ts";
import { syncCalendar } from "../src/lib/sync.ts";
import { input, jst, NOW, setup } from "./helpers.ts";

const expectErr = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(BookingError);
  expect((e as BookingError).code).toBe(code);
};

describe("予約確定", () => {
  it("オンライン: Meet発行・TUMIKI名で登録・招待・確認メール", async () => {
    const { deps, s, cal, mailer } = await setup();
    const r = await createBooking(deps, s, input(), "1.1.1.1");
    expect(r.fake).toBe(false);
    const ev = cal.events.get(r.id)!;
    expect(ev.summary).toBe("【TUMIKI】株式会社テスト様 お打ち合わせ");
    expect(ev.start?.dateTime).toBe(jst("2026-10-21", "13:30"));
    expect(ev.end?.dateTime).toBe(jst("2026-10-21", "14:30"));
    expect(ev.hangoutLink).toContain("meet.google.com");
    expect(ev.attendees?.[0]?.email).toBe("yamada@example.com");
    expect(ev.extendedProperties?.private?.tumikiBookingId).toBe(r.id);
    expect(ev.description).toContain(r.id);
    const b = (await getBooking(deps.db, r.id))!;
    expect(b.status).toBe("confirmed");
    expect(b.meet_url).toContain("meet.google.com");
    expect(mailer.sent).toHaveLength(1);
    const m = mailer.sent[0]!;
    expect(m.subject).toBe("【TUMIKI】お打ち合わせ予約が確定しました");
    expect(m.text).toContain("10月21日（水）13:30〜14:30");
    expect(m.text).toContain("オンライン（Google Meet）");
    expect(m.text).toContain(b.meet_url);
    expect(m.text).toContain(`/manage?b=${r.id}&t=${r.token}`);
    expect(await getBookingByToken(deps.db, r.id, r.token)).not.toBeNull();
    expect(await getBookingByToken(deps.db, r.id, "wrong")).toBeNull();
  });

  it("会社名が無ければお名前で登録", async () => {
    expect(eventTitle({ company: "", name: "山田" })).toBe("【TUMIKI】山田様 お打ち合わせ");
  });

  it("事務所: Meetなし・住所が場所欄とメールに入る", async () => {
    const { deps, s, cal, mailer } = await setup();
    const r = await createBooking(deps, s, input({ mode: "office" }));
    const ev = cal.events.get(r.id)!;
    expect(ev.hangoutLink).toBeUndefined();
    expect(ev.location).toContain("築山南半町234");
    expect(mailer.sent[0]!.text).toContain("築山南半町234");
    expect(mailer.sent[0]!.text).not.toContain("meet.google.com");
  });

  it("店舗名のみでも予約でき、住所未確認として記録される", async () => {
    const { deps, s, cal, mailer } = await setup();
    const r = await createBooking(deps, s, input({ mode: "visit", locationName: "居酒屋アホウどり 京大前店" }));
    const b = (await getBooking(deps.db, r.id))!;
    expect(b.address_unconfirmed).toBe(1);
    expect(b.location_source).toBe("customer");
    expect(cal.events.get(r.id)!.hangoutLink).toBeUndefined();
    expect(cal.events.get(r.id)!.location).toBe("居酒屋アホウどり 京大前店");
    expect(cal.events.get(r.id)!.description).toContain("住所は未確認");
    expect(mailer.sent[0]!.text).toContain("場所の詳細は、確認のうえ");
  });

  it("店舗名+住所なら住所確認済み", async () => {
    const { deps, s } = await setup();
    const r = await createBooking(deps, s, input({ mode: "visit", locationName: "A店", locationAddress: "京都市中京区1-2-3" }));
    expect((await getBooking(deps.db, r.id))!.address_unconfirmed).toBe(0);
  });

  it("場所を管理者が決める設定なら入力欄は無視される", async () => {
    const { deps, s } = await setup({ visitLocationBy: "admin" });
    const r = await createBooking(deps, s, input({ mode: "visit", locationName: "勝手な場所" }));
    const b = (await getBooking(deps.db, r.id))!;
    expect(b.location_source).toBe("admin");
    expect(b.location_name).toBe("");
    expect(b.address_unconfirmed).toBe(1);
  });

  it("入力検証: メール形式・必須・訪問先", async () => {
    const { deps, s } = await setup();
    await expectErr(createBooking(deps, s, input({ email: "bad@" })), "invalid");
    await expectErr(createBooking(deps, s, input({ name: " " })), "invalid");
    await expectErr(createBooking(deps, s, input({ mode: "visit" })), "invalid");
    await expectErr(createBooking(deps, s, input({ mode: "x" })), "invalid");
    await expectErr(createBooking(deps, s, input({ email: "a@b.com\r\nBcc: x@y.com" })), "invalid");
  });

  it("ハニーポットに入力があるボットは何も作られない", async () => {
    const { deps, s, cal } = await setup();
    const r = await createBooking(deps, s, input({ website: "http://spam" }));
    expect(r.fake).toBe(true);
    expect(cal.events.size).toBe(0);
  });
});

describe("空き時間・重複", () => {
  it("Googleの既存予定と重なる枠は出ない／終日予定・予定なしの扱い", async () => {
    const { deps, s, cal } = await setup();
    cal.addExternal("e1", jst("2026-10-21", "11:00"), jst("2026-10-21", "12:00"), { summary: "秘密の会議" });
    cal.addExternal("e2", jst("2026-10-22", "00:00"), jst("2026-10-23", "00:00")); // 終日(時刻で近似)
    cal.addExternal("e3", jst("2026-10-23", "10:00"), jst("2026-10-23", "18:00"), { transparency: "transparent" }); // 予定なし
    const days = await getAvailability(deps, s, "2026-10-21", "2026-10-23");
    expect(days["2026-10-21"]).not.toContain("10:15");
    expect(days["2026-10-21"]).toContain("10:00");
    expect(days["2026-10-21"]).toContain("12:00");
    expect(days["2026-10-22"]).toBeUndefined();
    expect(days["2026-10-23"]).toContain("10:00"); // 予定なしは妨げない
    expect(JSON.stringify(days)).not.toContain("秘密");
  });

  it("追加カレンダー(freeBusy)も空き判定に反映", async () => {
    const { deps, s, cal } = await setup({ busyCalendarIds: ["other@example.com"] });
    cal.freeBusyBusy = [{ start: Date.parse(jst("2026-10-21", "14:00")) / 1000, end: Date.parse(jst("2026-10-21", "15:00")) / 1000 }];
    const days = await getAvailability(deps, s, "2026-10-21", "2026-10-21");
    expect(days["2026-10-21"]).not.toContain("14:00");
    expect(days["2026-10-21"]).toContain("15:00");
  });

  it("既存予定がある時間には予約できない", async () => {
    const { deps, s, cal } = await setup();
    cal.addExternal("e1", jst("2026-10-21", "13:00"), jst("2026-10-21", "14:00"));
    await expectErr(createBooking(deps, s, input({ time: "13:30" })), "unavailable");
    expect(cal.insertCalls).toBe(0);
  });

  it("同時予約: 同じ時間は1件だけ成功する", async () => {
    const { deps, s, cal } = await setup({ maxFutureBookingsPerEmail: 20 });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => createBooking(deps, s, input({ email: `u${i}@example.com`, name: `客${i}` }), `9.9.9.${i}`)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as BookingError).code).toBe("unavailable");
    expect(cal.events.size).toBe(1);
    const { results: rows } = await deps.db.prepare("SELECT status FROM bookings").all<{ status: string }>();
    expect(rows.filter((x) => x.status === "confirmed")).toHaveLength(1);
  });

  it("重なる時間帯(15分ずれ)の同時予約も1件だけ", async () => {
    const { deps, s } = await setup({ maxFutureBookingsPerEmail: 20 });
    const times = ["13:00", "13:15", "13:30", "13:45"];
    const results = await Promise.allSettled(times.map((t, i) => createBooking(deps, s, input({ time: t, email: `u${i}@example.com` }), `8.8.8.${i}`)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("予約後は同じ時間が空きに出ない（DB予約もブロック）", async () => {
    const { deps, s, cal } = await setup();
    await createBooking(deps, s, input({ time: "13:30" }));
    cal.events.clear(); // Google側が空でもDBが守る
    const days = await getAvailability(deps, s, "2026-10-21", "2026-10-21");
    expect(days["2026-10-21"]).not.toContain("13:00");
    expect(days["2026-10-21"]).toContain("14:30");
  });

  it("作成の直前に外部予定が入った場合は取り消され、イベントも予約も残らない", async () => {
    const { deps, s, cal, mailer } = await setup();
    cal.onAfterInsert = () => cal.addExternal("late", jst("2026-10-21", "13:45"), jst("2026-10-21", "14:15"));
    await expectErr(createBooking(deps, s, input()), "unavailable");
    expect([...cal.events.keys()]).toEqual(["late"]); // 当方のイベントは削除済み
    const { results } = await deps.db.prepare("SELECT status FROM bookings").all<{ status: string }>();
    expect(results.map((r) => r.status)).toEqual(["failed"]);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe("障害時の整合性", () => {
  it("Googleカレンダー登録失敗 → 予約は確定扱いにならない・メールも送らない", async () => {
    const { deps, s, cal, mailer } = await setup();
    cal.failInsert = true;
    await expectErr(createBooking(deps, s, input()), "google");
    const { results } = await deps.db.prepare("SELECT status FROM bookings").all<{ status: string }>();
    expect(results.map((r) => r.status)).toEqual(["failed"]);
    expect(mailer.sent).toHaveLength(0);
    // 失敗した枠は再度予約できる
    cal.failInsert = false;
    const ok = await createBooking(deps, s, input());
    expect((await getBooking(deps.db, ok.id))!.status).toBe("confirmed");
  });

  it("Meetが発行できなければ失敗扱い・イベントを残さない", async () => {
    const { deps, s, cal } = await setup();
    cal.failMeet = true;
    await expectErr(createBooking(deps, s, input()), "google");
    expect(cal.events.size).toBe(0);
  });

  it("メール送信失敗でも予約は確定のまま。履歴に失敗が残り再送できる", async () => {
    const { deps, s, mailer } = await setup();
    mailer.fail = true;
    const r = await createBooking(deps, s, input());
    expect((await getBooking(deps.db, r.id))!.status).toBe("confirmed");
    const log = await deps.db.prepare("SELECT status, error FROM mail_log").all<{ status: string; error: string }>();
    expect(log.results[0]).toMatchObject({ status: "failed", error: "smtp down" });
    mailer.fail = false;
    const { resendConfirmation } = await import("../src/lib/booking.ts");
    expect(await resendConfirmation(deps, s, r.id)).toBe(true);
    expect(mailer.sent).toHaveLength(1);
  });

  it("期限切れの仮押さえはcronで掃除され、Googleの孤立イベントも消える", async () => {
    const { deps, s, cal, db } = await setup();
    const { newBookingId } = await import("../src/lib/crypto.ts");
    const id = newBookingId();
    await db.prepare(`INSERT INTO bookings (id,status,start_ts,end_ts,block_start_ts,block_end_ts,mode,name,email,manage_token_hash,created_at,updated_at) VALUES (?,'pending',1,2,1,2,'online','a','a@b.com','x',?,?)`)
      .bind(id, deps.now!() - 3600, deps.now!() - 3600).run();
    cal.addExternal(id, jst("2026-10-21", "10:00"), jst("2026-10-21", "11:00"));
    expect(await cleanupPending(deps, s)).toBe(1);
    expect(cal.events.has(id)).toBe(false);
    expect((await getBooking(db, id))!.status).toBe("failed");
  });
});

describe("変更・キャンセル", () => {
  it("日時変更: 既存イベントを更新し、変更メールを送る。自分の旧枠は空きに出る", async () => {
    const { deps, s, cal, mailer } = await setup();
    const r = await createBooking(deps, s, input());
    const days = await getAvailability(deps, s, "2026-10-21", "2026-10-21", r.id);
    expect(days["2026-10-21"]).toContain("13:30"); // 自分の予約は除外して判定
    await rescheduleBooking(deps, s, r.id, "2026-10-22", "10:15", "customer", r.token);
    const ev = cal.events.get(r.id)!;
    expect(ev.start?.dateTime).toBe(jst("2026-10-22", "10:15"));
    expect(cal.events.size).toBe(1);
    expect(mailer.sent.at(-1)!.subject).toContain("変更");
    expect(mailer.sent.at(-1)!.text).toContain("10月22日（木）10:15〜11:15");
    const after = await getAvailability(deps, s, "2026-10-21", "2026-10-21");
    expect(after["2026-10-21"]).toContain("13:30"); // 旧枠は解放
  });

  it("変更先が埋まっていれば拒否され、元の予約は変わらない", async () => {
    const { deps, s, cal } = await setup();
    const r = await createBooking(deps, s, input());
    cal.addExternal("x", jst("2026-10-22", "10:00"), jst("2026-10-22", "11:00"));
    await expectErr(rescheduleBooking(deps, s, r.id, "2026-10-22", "10:15", "customer", r.token), "unavailable");
    const b = (await getBooking(deps.db, r.id))!;
    expect(b.start_ts).toBe(Date.parse(jst("2026-10-21", "13:30")) / 1000);
  });

  it("キャンセル: Googleのイベント削除・メール・枠の解放", async () => {
    const { deps, s, cal, mailer } = await setup();
    const r = await createBooking(deps, s, input());
    await cancelBooking(deps, s, r.id, "customer", r.token);
    expect(cal.events.has(r.id)).toBe(false);
    expect((await getBooking(deps.db, r.id))!.status).toBe("cancelled");
    expect(mailer.sent.at(-1)!.subject).toContain("キャンセル");
    await expectErr(cancelBooking(deps, s, r.id, "customer"), "not_found"); // 二重キャンセル
    const again = await createBooking(deps, s, input({ email: "z@example.com" }), "2.2.2.2");
    expect(again.fake).toBe(false);
  });

  it("開始直前はお客様側から変更できない", async () => {
    const { deps, s } = await setup();
    const r = await createBooking(deps, s, input({ date: "2026-10-20", time: "11:00" }));
    deps.now = () => NOW + 30 * 60; // 開始まで1.5時間 < 締切2時間
    await expectErr(rescheduleBooking(deps, s, r.id, "2026-10-21", "10:00", "customer", r.token), "forbidden");
  });
});

describe("Googleカレンダーとの同期", () => {
  it("カレンダーで直接削除 → 予約がキャンセルに / 時間変更 → 予約の日時が更新", async () => {
    const { deps, s, cal } = await setup({ maxFutureBookingsPerEmail: 5 });
    const a = await createBooking(deps, s, input({ time: "10:00" }));
    const b = await createBooking(deps, s, input({ time: "14:00", email: "b@example.com" }), "3.3.3.3");
    await syncCalendar(deps, s); // 自分の作成分(エコー)は変化なし
    expect((await getBooking(deps.db, a.id))!.externally_changed).toBe(0);

    cal.events.delete(a.id);
    cal.changeLog.push({ id: a.id, status: "cancelled", extendedProperties: { private: { tumikiBookingId: a.id } } });
    cal.events.get(b.id)!.start = { dateTime: jst("2026-10-21", "15:00") };
    cal.events.get(b.id)!.end = { dateTime: jst("2026-10-21", "16:00") };
    cal.changeLog.push(cal.events.get(b.id)!);

    const res = await syncCalendar(deps, s);
    expect(res).toMatchObject({ cancelled: 1, moved: 1 });
    expect(await getBooking(deps.db, a.id)).toMatchObject({ status: "cancelled", cancelled_by: "calendar" });
    expect(await getBooking(deps.db, b.id)).toMatchObject({ externally_changed: 1, start_ts: Date.parse(jst("2026-10-21", "15:00")) / 1000 });
    // 通知とcronが二重に来ても冪等
    cal.changeLog.push(cal.events.get(b.id)!);
    expect(await syncCalendar(deps, s)).toMatchObject({ cancelled: 0, moved: 0 });
  });

  it("無関係なカレンダー予定は無視される", async () => {
    const { deps, s, cal } = await setup();
    cal.addExternal("zzz", jst("2026-10-21", "10:00"), jst("2026-10-21", "11:00"));
    expect(await syncCalendar(deps, s)).toMatchObject({ checked: 0 });
  });

  it("syncToken失効(410)から自動復旧", async () => {
    const { deps, s, db } = await setup();
    await db.prepare("INSERT INTO sync_state (key,value,updated_at) VALUES (?,?,1)").bind("sync_token:primary", "expired").run();
    await expect(syncCalendar(deps, s)).resolves.toBeTruthy();
  });
});
