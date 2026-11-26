import {describe,test,expect} from "bun:test";
import {formatJalali,formatJalaliDateTime,formatTime,formatTime24} from "../src/lib/jalali";

describe("telemetry date display",()=>{
 const timestamp=Date.UTC(2026,10,22,7,15);
 const formatters=[formatJalali,formatJalaliDateTime,formatTime,formatTime24];
 test("ADMS epoch milliseconds display like ISO dates",()=>{
  for(const format of formatters) {
   expect(format(timestamp)).toBe(format(new Date(timestamp)));
   expect(format(timestamp)).toBe(format(new Date(timestamp).toISOString()));
   expect(format(timestamp)).not.toBe("—");
  }
 });
 test("missing and malformed runtime values do not crash the dialog",()=>{
  for(const format of formatters)for(const value of [null,undefined,"",NaN,Infinity,"invalid",{},[],true]) {
   expect(format(value as Date)).toBe("—");
  }
 });
 test("epoch zero is a valid date, not a missing value",()=>{
  for(const format of formatters)expect(format(0)).toBe(format(new Date(0)));
 });
});
