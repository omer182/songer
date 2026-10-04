// Tiny build label in the bottom-left corner, to tell which build is running. Links to the commit.
export function VersionTag() {
  const when = new Date(__BUILD_TIME__);
  const stamp = isNaN(when.getTime())
    ? ''
    : ` · ${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  const label = `v${__APP_VERSION__} · ${__APP_COMMIT__}${stamp}`;
  const href = /^[0-9a-f]{7}$/.test(__APP_COMMIT__) ? `https://github.com/omer182/songer/commit/${__APP_COMMIT__}` : undefined;
  return href ? (
    <a className="version-tag" href={href} target="_blank" rel="noreferrer" title="Build version">{label}</a>
  ) : (
    <span className="version-tag" title="Build version">{label}</span>
  );
}
