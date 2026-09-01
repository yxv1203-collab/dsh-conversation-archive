const fileUserUrl = /file:\/\/\/[A-Za-z]:[\\/]Users[\\/][^\s"'`]+/i
// Raw source can contain either one backslash or an escaped pair.
const windowsUserPath = new RegExp('[A-Za-z]:(?:\\\\){1,2}Users(?:\\\\){1,2}[A-Za-z0-9._-]+', 'i')

export function assertPortableSources(source, stalePathForms = []) {
  if (stalePathForms.some((form) => source.includes(form)) || fileUserUrl.test(source) || windowsUserPath.test(source)) {
    throw new Error('integration sources contain a user-specific or stale plugin path')
  }
}
