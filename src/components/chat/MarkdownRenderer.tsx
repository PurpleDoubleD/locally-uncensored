import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock'
import type { Components } from 'react-markdown'

interface Props {
  content: string
}

const components: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '')
    const isBlock = match || (typeof children === 'string' && children.includes('\n'))

    if (isBlock) {
      return <CodeBlock code={String(children).replace(/\n$/, '')} language={match?.[1]} />
    }

    return (
      <code className="bg-white/10 px-1.5 py-0.5 rounded text-gray-200 text-sm font-mono" {...props}>
        {children}
      </code>
    )
  },
  p({ children }) {
    return <p className="mb-3 leading-relaxed">{children}</p>
  },
  h1({ children }) {
    return <h1 className="text-xl font-bold mb-3 text-white">{children}</h1>
  },
  h2({ children }) {
    return <h2 className="text-lg font-bold mb-2 text-white">{children}</h2>
  },
  h3({ children }) {
    return <h3 className="text-base font-semibold mb-2 text-white">{children}</h3>
  },
  ul({ children }) {
    return <ul className="list-disc list-inside mb-3 space-y-1">{children}</ul>
  },
  ol({ children }) {
    return <ol className="list-decimal list-inside mb-3 space-y-1">{children}</ol>
  },
  blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-white/20 pl-4 my-3 text-gray-400 italic">
        {children}
      </blockquote>
    )
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto my-3">
        <table className="w-full border-collapse border border-white/10 text-sm">{children}</table>
      </div>
    )
  },
  th({ children }) {
    return <th className="border border-white/10 px-3 py-2 bg-white/5 text-left font-semibold">{children}</th>
  },
  td({ children }) {
    return <td className="border border-white/10 px-3 py-2">{children}</td>
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
        {children}
      </a>
    )
  },
}

export function MarkdownRenderer({ content }: Props) {
  return (
    <div className="markdown-content text-gray-200">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
