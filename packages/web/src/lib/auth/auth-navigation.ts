let navigateHandler: NavigationHandler | null = null

function setAuthNavigator(handler: NavigationHandler | null): void {
  navigateHandler = handler
}

function getAuthNavigator(): NavigationHandler | null {
  return navigateHandler
}

function navigateToLogin(options?: NavigateToLoginOptions): void {
  const currentPath = typeof window !== 'undefined' ? window.location.pathname : ''
  if (currentPath.startsWith('/login')) {
    return
  }

  const returnUrl =
    options?.returnUrl ??
    (typeof window !== 'undefined'
      ? `${window.location.pathname}${window.location.search}${window.location.hash}`
      : '')

  const search =
    returnUrl && returnUrl !== '/'
      ? `?returnUrl=${encodeURIComponent(returnUrl)}`
      : ''

  const target = `/login${search}`
  const navOptions = {
    replace: options?.replace ?? true,
    state:
      options?.state ??
      (returnUrl ? { from: { pathname: returnUrl } } : undefined),
  }

  if (navigateHandler) {
    navigateHandler(target, navOptions)
    return
  }

  if (typeof window !== 'undefined') {
    try {
      if (typeof window.location.assign === 'function') {
        window.location.assign(target)
      } else {
        window.location.href = target
      }
    } catch {
      // In non-browser or stubbed test environments, ignore assign errors
    }
  }
}

export const authNavigation = {
  setAuthNavigator,
  getAuthNavigator,
  navigateToLogin,
}

export { setAuthNavigator, getAuthNavigator, navigateToLogin }

export type NavigationHandler = (
  path: string,
  options?: { replace?: boolean; state?: unknown }
) => void

export type NavigateToLoginOptions = {
  returnUrl?: string
  replace?: boolean
  state?: unknown
}
