import { describe, expect, it } from "vitest";
import type { CalendarRule, Schedule } from "./schedule";
import { type ParsedScheduleText, formatScheduleText, parseScheduleText } from "./schedule-text";

// 参考：2026-10-08 は木曜。2026-10-04 は日曜。
const TODAY = "2026-10-08";
const parse = (t: string) => parseScheduleText(t, TODAY);

const iv = (intervalDays: number): ParsedScheduleText => ({ ok: true, kind: "interval", intervalDays });
const weekly = (weekdays: number[], every = 1) => ({ ok: true, kind: "calendar", rule: { kind: "weekly", weekdays, every }, needsAnchor: every >= 2 });
const mday = (day: number, every = 1) => ({ ok: true, kind: "calendar", rule: { kind: "monthly_day", day, every }, needsAnchor: every >= 2 });
const mnth = (nth: number, weekday: number, every = 1) => ({ ok: true, kind: "calendar", rule: { kind: "monthly_nth_weekday", nth, weekday, every }, needsAnchor: every >= 2 });

/** 読めて、期待どおりになる（suggestedAnchor は別に確かめる） */
function expectParsed(texts: string[], expected: object) {
  for (const t of texts) expect(parse(t), t).toMatchObject(expected);
}

describe("日数の周期を読む", () => {
  it("7・7日・7日ごと・7日おき・全角・空白", () => {
    expectParsed(["7", "7日", "7日ごと", "7日おき", "７日ごと", "７", " 7 日 ごと ", "7日毎", "7日に1回"], iv(7));
  });
  it("週1・毎週（曜日なし）は7日ごと", () => {
    expectParsed(["週1", "週１", "週1回", "毎週"], iv(7));
  });
  it("隔週・N週ごと（曜日なし）は日数にする", () => {
    expectParsed(["隔週"], iv(14));
    expectParsed(["3週ごと", "３週ごと", "3週"], iv(21));
  });
  it("毎日・隔日", () => {
    expectParsed(["毎日", "1日ごと", "1日おき"], iv(1));
    expectParsed(["隔日", "2日"], iv(2));
  });
  it("1〜3660日", () => {
    expectParsed(["3660日ごと"], iv(3660));
    expectParsed(["30"], iv(30));
  });
});

describe("毎週の周期を読む", () => {
  it("曜日・曜の有無と区切り", () => {
    const monThu = weekly([1, 4]);
    expectParsed(
      ["毎週 月・木曜", "毎週月木", "月木", "月・木", "月、木", "月,木", "月/木", "月，木", "月／木", "毎週 月曜・木曜", "毎週月曜日と木曜日", "木月", "月 木", "毎週　月・木"],
      monThu,
    );
  });
  it("1つの曜日", () => {
    expectParsed(["日", "日曜", "日曜日", "毎週日曜"], weekly([0]));
    expectParsed(["土", "毎週 土曜"], weekly([6]));
  });
  it("同じ曜日は1つにまとめ、並べ替える", () => {
    expectParsed(["土・月・月"], weekly([1, 6]));
    expectParsed(["土日"], weekly([0, 6]));
    expectParsed(["平日"], weekly([1, 2, 3, 4, 5]));
  });
  it("隔週・N週ごとは基準日が要る", () => {
    expectParsed(["隔週土", "隔週 土曜", "2週ごと 土", "2週ごと土曜日", "２週おき 土"], weekly([6], 2));
    expectParsed(["3週ごと 月・水", "3週月水"], weekly([1, 3], 3));
    expectParsed(["1週ごと 火"], weekly([2], 1));
  });
  it("基準日の候補は今日以降で最初に当たる日", () => {
    expect(parse("隔週 土")).toMatchObject({ suggestedAnchor: "2026-10-10" });
    expect(parse("隔週 木")).toMatchObject({ suggestedAnchor: "2026-10-08" });
    expect(parse("毎週 土")).not.toHaveProperty("suggestedAnchor");
  });
  it("rule に anchor を入れない", () => {
    const r = parse("隔週 土");
    expect(r.ok && r.kind === "calendar" && "anchor" in r.rule).toBe(false);
  });
});

describe("毎月の周期を読む", () => {
  it("毎月○日", () => {
    expectParsed(["毎月1日", "毎月 1日", "1日", "１日", "毎月 01日"], mday(1));
    expectParsed(["毎月15日", "毎月 １５日"], mday(15));
    expectParsed(["毎月31日"], mday(31));
  });
  it("月末・末日", () => {
    expectParsed(["月末", "末日", "毎月 末日", "毎月月末", "毎月末"], mday(-1));
  });
  it("第n○曜・最終○曜", () => {
    expectParsed(["毎月第2火曜", "毎月 第2火曜日", "第2火", "第２火", "第2火曜"], mnth(2, 2));
    expectParsed(["最終金曜", "最終金", "毎月 最終金曜日", "最後の金曜"], mnth(-1, 5));
    expectParsed(["第5日曜"], mnth(5, 0));
  });
  it("数か月ごと（か・ヶ・カ・ヵ）", () => {
    expectParsed(["3か月ごと 第1日曜", "3ヶ月ごと 第1日曜", "3カ月ごと第1日曜", "3ヵ月ごと 第1日", "３ケ月 第1日曜日", "3ｶ月ごと 第1日曜"], mnth(1, 0, 3));
    expectParsed(["3か月ごと 最終金曜"], mnth(-1, 5, 3));
    expectParsed(["2か月ごと 末日", "隔月 末日"], mday(-1, 2));
    expectParsed(["6か月ごと 10日"], mday(10, 6));
    expectParsed(["1か月ごと 5日"], mday(5, 1));
  });
  it("数か月ごとの基準日の候補", () => {
    expect(parse("3か月ごと 1日")).toMatchObject({ needsAnchor: true, suggestedAnchor: "2026-11-01" });
    expect(parse("2か月ごと 第2木曜")).toMatchObject({ needsAnchor: true, suggestedAnchor: "2026-10-08" });
    expect(parse("2か月ごと 末日")).toMatchObject({ needsAnchor: true, suggestedAnchor: "2026-10-31" });
  });
});

describe("読めない書き方", () => {
  const bad = (t: string, part: string) => {
    const r = parse(t);
    expect(r.ok, t).toBe(false);
    if (!r.ok) expect(r.message, t).toContain(part);
  };
  it("空", () => {
    bad("", "空");
    bad("   ", "空");
  });
  it("日数の範囲外", () => {
    bad("0", "1〜3660");
    bad("0日ごと", "1〜3660");
    bad("3661日", "1〜3660");
  });
  it("週・月の間隔の範囲外", () => {
    bad("25週ごと 月", "1〜24週");
    bad("0週ごと 月", "1〜24週");
    bad("25か月ごと 1日", "1〜24か月");
    bad("0か月ごと 1日", "1〜24か月");
  });
  it("日にち・第何週の範囲外", () => {
    bad("毎月32日", "1〜31");
    bad("毎月0日", "1〜31");
    bad("第6火曜", "第1〜第5");
    bad("第0火曜", "第1〜第5");
  });
  it("毎月だけ・日にちが読めない", () => {
    bad("毎月", "何日か");
    bad("3か月ごと", "何日か");
    bad("毎月 ほげ", "日にちが読めません");
  });
  it("曜日が読めない", () => {
    bad("毎週 ほげ", "曜日が読めません");
    bad("隔週 月・x", "曜日が読めません");
  });
  it("そのほか", () => {
    bad("ときどき", "周期として読めません");
    bad("週2", "周期として読めません");
    bad("7日ごとx", "周期として読めません");
    bad("-7", "周期として読めません");
    bad("1.5日", "周期として読めません");
  });
});

describe("書いて読むと元に戻る", () => {
  const A = "2026-10-04";
  const rules: CalendarRule[] = [
    { kind: "weekly", weekdays: [1, 4], every: 1, anchor: A },
    { kind: "weekly", weekdays: [0], every: 1, anchor: A },
    { kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], every: 1, anchor: A },
    { kind: "weekly", weekdays: [6], every: 2, anchor: A },
    { kind: "weekly", weekdays: [2, 5], every: 3, anchor: A },
    { kind: "weekly", weekdays: [3], every: 24, anchor: A },
    { kind: "monthly_nth_weekday", nth: 1, weekday: 0, every: 1, anchor: A },
    { kind: "monthly_nth_weekday", nth: 5, weekday: 6, every: 1, anchor: A },
    { kind: "monthly_nth_weekday", nth: -1, weekday: 5, every: 3, anchor: A },
    { kind: "monthly_day", day: 1, every: 1, anchor: A },
    { kind: "monthly_day", day: 31, every: 1, anchor: A },
    { kind: "monthly_day", day: -1, every: 1, anchor: A },
    { kind: "monthly_day", day: 15, every: 12, anchor: A },
  ];
  const schedules: Schedule[] = [
    ...[1, 2, 7, 14, 21, 30, 365, 3660].map((n): Schedule => ({ type: "interval", intervalDays: n, firstDueOn: A })),
    ...rules.map((rule): Schedule => ({ type: "calendar", rule })),
  ];

  it("describeSchedule と同じ書き方", () => {
    expect(formatScheduleText({ type: "interval", intervalDays: 7, firstDueOn: A })).toBe("7日ごと");
    expect(formatScheduleText({ type: "calendar", rule: rules[0]! })).toBe("毎週 月・木曜");
    expect(formatScheduleText({ type: "calendar", rule: rules[3]! })).toBe("隔週 土曜");
    expect(formatScheduleText({ type: "calendar", rule: rules[6]! })).toBe("毎月 第1日曜");
    expect(formatScheduleText({ type: "calendar", rule: rules[8]! })).toBe("3か月ごと 最終金曜");
    expect(formatScheduleText({ type: "calendar", rule: rules[9]! })).toBe("毎月 1日");
    expect(formatScheduleText({ type: "calendar", rule: rules[11]! })).toBe("毎月 末日");
  });

  it.each(schedules.map((s) => [formatScheduleText(s), s] as const))("%s", (text, s) => {
    const r = parse(text);
    if (s.type === "interval") {
      expect(r).toEqual({ ok: true, kind: "interval", intervalDays: s.intervalDays });
    } else {
      const { anchor: _, ...rule } = s.rule;
      expect(r).toMatchObject({ ok: true, kind: "calendar", rule, needsAnchor: s.rule.every >= 2 });
      if (r.ok && r.kind === "calendar") expect(r.rule).toEqual(rule);
    }
  });
});
