// やり方の描画（components/Markdown）。HTML の直書きを出さないこと、リンク・チェックリスト・表の形を確かめる
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Markdown from "./Markdown";

const render = (text: string) => renderToString(createElement(Markdown, { text }));

describe("やり方の Markdown", () => {
  it("見出し・箇条書き・太字・表を描く。見出しは h3 から", () => {
    const html = render("# 手順\n\n- **ぬめり**を落とす\n\n| 道具 | 場所 |\n| --- | --- |\n| ブラシ | 棚 |");
    expect(html).toContain('<h3 class="md__h md__h1">手順</h3>');
    expect(html).toContain("<li><strong>ぬめり</strong>を落とす</li>");
    expect(html).toMatch(/<div class="md__table"><table>.*<th>道具<\/th>.*<td>ブラシ<\/td>/s);
  });

  it("チェックリストは押せない印にする（input を出さない）", () => {
    const html = render("- [ ] ふたを外す\n- [x] 洗う");
    expect(html).not.toContain("<input");
    expect(html).toContain('class="md__check" role="img" aria-label="やることの印"');
    expect(html).toContain('class="md__check is-checked"');
  });

  it("リンクは新しいタブで、rel=noopener", () => {
    const html = render("[説明書](https://example.com/a)");
    expect(html).toContain('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">説明書</a>');
  });

  it("HTML の直書き・javascript: のリンク・画像の onerror は出さない", () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n前<b onclick="alert(4)">太</b>後\n\n[押す](javascript:alert(3))\n\n![x](javascript:alert(5))');
    expect(html).not.toMatch(/<script|<img|<b[ >]|onerror|onclick|javascript:/i);
    expect(html).toContain("押す");
  });
});
