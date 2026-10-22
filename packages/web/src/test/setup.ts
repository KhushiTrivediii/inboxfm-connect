import { vi } from 'vitest'
import '../lib/i18n'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
})

function createStorageMock(): Storage {
  const store = new Map<string, string>()
  const target: Storage = {
    get length(): number {
      return store.size
    },
    clear(): void {
      store.clear()
    },
    getItem(key: string): string | null {
      return store.get(key) ?? null
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null
    },
    removeItem(key: string): void {
      store.delete(key)
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value))
    },
  }

  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'string' && prop in t) {
        return Reflect.get(t, prop, receiver)
      }
      if (typeof prop === 'string') {
        return store.get(prop) ?? undefined
      }
      return Reflect.get(t, prop, receiver)
    },
    set(t, prop, value, receiver) {
      if (typeof prop === 'string' && prop in t) {
        return Reflect.set(t, prop, value, receiver)
      }
      if (typeof prop === 'string') {
        store.set(prop, String(value))
        return true
      }
      return Reflect.set(t, prop, value, receiver)
    },
    deleteProperty(t, prop) {
      if (typeof prop === 'string') {
        store.delete(prop)
        return true
      }
      return Reflect.deleteProperty(t, prop)
    },
    ownKeys() {
      return Array.from(store.keys())
    },
    getOwnPropertyDescriptor(t, prop) {
      if (typeof prop === 'string' && store.has(prop)) {
        return {
          value: store.get(prop),
          writable: true,
          enumerable: true,
          configurable: true,
        }
      }
      return undefined
    },
  })
}

const mockLocalStorage = createStorageMock()
const mockSessionStorage = createStorageMock()

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: mockLocalStorage,
})
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  writable: true,
  value: mockSessionStorage,
})
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    writable: true,
    value: mockLocalStorage,
  })
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: mockSessionStorage,
  })
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
})

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(window, 'ResizeObserver', {
  configurable: true,
  writable: true,
  value: ResizeObserverStub,
})

Element.prototype.scrollIntoView = () => {}

class RequestStub {
  url: string
  method: string
  headers: Headers

  constructor(input: string | RequestStub, init?: { method?: string; headers?: HeadersInit }) {
    this.url =
      typeof input === 'string' ? new URL(input, window.location.origin).toString() : input.url
    this.method = init?.method ?? 'GET'
    this.headers = new Headers(init?.headers)
  }
}

Object.defineProperty(window, 'Request', {
  configurable: true,
  writable: true,
  value: RequestStub,
})
