// やり方（Markdown）を描く。react-markdown＋remark-gfm で React の要素にするだけで、HTML は出さない
// （rehype-raw は使わず skipHtml で HTML の直書きを捨てる。javascript: などのリンクは react-markdown が消す）。
// 重いので Howto.tsx から lazy で読む。
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** 見出しは画面の見出し（h1 家事の名前、h2 区切り）の下に入るよう、h3 から始める */
const heading =
  (level: 1 | 2 | 3 | 4 | 5 | 6) =>
  ({ children }: { children?: ReactNode }) => {
    const Tag = `h${Math.min(level + 2, 6)}` as "h3";
    return <Tag className={`md__h md__h${level}`}>{children}</Tag>;
  };

const components: Components = {
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // 画像は読み込まない（知らないところへ取りに行かない）。リンクにしておく
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer">
        画像：{alt || src}
      </a>
    ) : null,
  // チェックリストの印は読むだけ（押せない）。記録の仕組みにはしない
  input: ({ checked, type }) =>
    type === "checkbox" ? <span className={`md__check${checked ? " is-checked" : ""}`} role="img" aria-label={checked ? "済みの印" : "やることの印"} /> : null,
  table: ({ children }) => (
    <div className="md__table">
      <table>{children}</table>
    </div>
  ),
};

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
