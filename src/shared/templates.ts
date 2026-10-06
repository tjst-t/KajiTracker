// 「よくある家事から選ぶ」の候補。グループは名前で、その Family のグループに当てる（無ければグループ無し）
export type TemplateSchedule = { type: "interval"; intervalDays: number } | { type: "weekly"; weekdays: number[] };

export type ChoreTemplate = { name: string; group: string; schedule: TemplateSchedule };

const every = (intervalDays: number): TemplateSchedule => ({ type: "interval", intervalDays });
const weekly = (...weekdays: number[]): TemplateSchedule => ({ type: "weekly", weekdays });

export const CHORE_TEMPLATES: ChoreTemplate[] = [
  { group: "キッチン", name: "シンクの排水口", schedule: every(7) },
  { group: "キッチン", name: "コンロまわり", schedule: every(7) },
  { group: "キッチン", name: "冷蔵庫の整理", schedule: every(30) },
  { group: "キッチン", name: "電子レンジの中", schedule: every(30) },
  { group: "キッチン", name: "換気扇のフィルター", schedule: every(90) },
  { group: "風呂", name: "風呂の排水口", schedule: every(7) },
  { group: "風呂", name: "風呂のカビ取り", schedule: every(30) },
  { group: "風呂", name: "風呂釜の洗浄", schedule: every(30) },
  { group: "風呂", name: "シャワーヘッドの掃除", schedule: every(90) },
  { group: "トイレ", name: "トイレ掃除", schedule: every(7) },
  { group: "トイレ", name: "トイレのタンク", schedule: every(90) },
  { group: "洗濯", name: "シーツ・枕カバーの洗濯", schedule: every(7) },
  { group: "洗濯", name: "洗濯機の糸くずフィルター", schedule: every(14) },
  { group: "洗濯", name: "洗濯槽の掃除", schedule: every(30) },
  { group: "ゴミ捨て", name: "燃えるゴミ", schedule: weekly(1, 4) },
  { group: "ゴミ捨て", name: "資源ゴミ", schedule: weekly(3) },
  { group: "掃除", name: "掃除機がけ", schedule: every(3) },
  { group: "掃除", name: "布団干し", schedule: every(14) },
  { group: "掃除", name: "エアコンのフィルター", schedule: every(90) },
  { group: "掃除", name: "窓ふき", schedule: every(90) },
  { group: "掃除", name: "火災報知器の点検", schedule: every(180) },
];
