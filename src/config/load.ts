import storesJson from "../../config/stores.json";
import holidaysJson from "../../config/holidays.json";
import { parseConfig, type AppConfig } from "./config";
import { BankCalendar } from "../domain/calendar";

export function loadDefaultConfig(): AppConfig {
  return parseConfig(storesJson);
}

export function loadDefaultCalendar(): BankCalendar {
  return new BankCalendar(holidaysJson.dates);
}
