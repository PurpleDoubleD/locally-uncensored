/**
 * A message the user wrote while the run was going, drawn where the run read
 * it (CA U2). Right-aligned and small: the user's voice inside the agent's turn.
 */
export function SteerNote({ text }: { text: string }) {
  return (
    <div className="flex justify-end py-1" data-testid="steer-note">
      <div className="max-w-[80%] rounded-lg bg-gray-100 dark:bg-white/[0.06] border border-gray-200 dark:border-white/[0.08] px-2.5 py-1.5">
        <div className="t-micro text-gray-500 dark:text-gray-400">You, during the run</div>
        <div className="t-control leading-relaxed text-gray-800 dark:text-gray-100 whitespace-pre-wrap break-words">{text}</div>
      </div>
    </div>
  )
}
