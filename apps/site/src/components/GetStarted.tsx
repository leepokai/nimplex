export const REPO_URL = "https://github.com/leepokai/nimplex";

/**
 * The README quickstart: install, sign in, then a task that works in the empty session
 * workspace. Docker runs the native command, so no sandbox account is needed.
 */
const INSTALL = [
  "git clone https://github.com/leepokai/nimplex && cd nimplex",
  "pnpm install && (cd apps/cli && pnpm link --global)  # `pnpm setup` first if asked",
  "nimplex login                 # or set ANTHROPIC_API_KEY",
  'nimplex --sandbox docker "Create hello.js that prints hi, then run it with node"',
];

/** Primary action: the repository, plus the commands to run it locally. */
export function GetStarted({ id }: { id?: string }) {
  return (
    <div className="get-started" id={id}>
      <a className="btn btn-primary" href={REPO_URL} target="_blank" rel="noopener noreferrer">
        View on GitHub
      </a>
      <pre className="install">
        {INSTALL.map((line) => (
          <code key={line}>
            <span className="prompt">$ </span>
            {line}
          </code>
        ))}
      </pre>
    </div>
  );
}
