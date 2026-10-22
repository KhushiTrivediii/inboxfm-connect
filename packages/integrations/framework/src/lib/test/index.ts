import { ExecutionType } from '@inboxfm-connect/core-piece-types';
import { ToolContext } from '../context';
import { InputPropertyMap, StaticPropsValue } from '../property';

/**
 * Builds an ActionContext for unit-testing an action in isolation.
 *
 * Mirrors createMockToolContext: every collaborator is stubbed, so an action's
 * `run` can be invoked directly without a flow run, auth or a real store.
 * The auth slot stays undefined - pass `auth` to exercise an authed action.
 *
 * `ActionContext` is the public alias for `ToolContext` (re-exported from
 * ../index), so one context type backs both actions and tools.
 */
export function createMockActionContext<
  Props extends InputPropertyMap
>(params: {
  propsValue: StaticPropsValue<Props>;
  auth?: ToolContext<undefined, Props>['auth'];
}): ToolContext<undefined, Props> {
  return {
    executionType: ExecutionType.BEGIN,
    auth: params.auth as ToolContext<undefined, Props>['auth'],
    propsValue: params.propsValue,
    store: {
      put: async <T>(key: string, value: T) => value,
      get: async () => null,
      delete: async () => {
        return;
      },
    },
    connections: {
      get: async () => null,
    },
    tags: {
      add: async () => {
        return;
      },
    },
    server: {
      apiUrl: 'http://localhost:3000',
      publicUrl: 'http://localhost:4200',
      token: 'test-token',
    },
    files: {
      write: async () => 'test-file-url',
    },
    output: {
      update: async () => {
        return;
      },
    },
    agent: {
      tools: async () => ({}),
    },
    run: {
      id: 'test-run-id' as string,
      stop: () => {
        return;
      },
      pause: () => {
        return;
      },
      respond: () => {
        return;
      },
    },
    project: {
      id: 'test-project-id',
      externalId: async () => undefined,
    },
    flows: {
      list: async () => ({ data: [], next: null, previous: null }),
      current: {
        id: 'test-flow-id',
        version: {
          id: 'test-flow-version-id',
        },
      },
    },
    step: {
      name: 'test-step',
    },
    generateResumeUrl: () => 'http://localhost:3000/resume',
  } as unknown as ToolContext<undefined, Props>;
}

export function createMockToolContext<
  Props extends InputPropertyMap
>(params: {
  propsValue: StaticPropsValue<Props>;
}): ToolContext<undefined, Props> {
  return {
    executionType: ExecutionType.BEGIN,
    auth: undefined,
    propsValue: params.propsValue,
    store: {
      put: async <T>(key: string, value: T) => value,
      get: async () => null,
      delete: async () => {
        return;
      },
    },
    connections: {
      get: async () => null,
    },
    tags: {
      add: async () => {
        return;
      },
    },
    server: {
      apiUrl: 'http://localhost:3000',
      publicUrl: 'http://localhost:4200',
      token: 'test-token',
    },
    files: {
      write: async () => 'test-file-url',
    },
    output: {
      update: async () => {
        return;
      },
    },
    agent: {
      tools: async () => ({}),
    },
    run: {
      id: 'test-run-id' as string,
      stop: () => {
        return;
      },
      pause: () => {
        return;
      },
      respond: () => {
        return;
      },
    },
    project: {
      id: 'test-project-id',
      externalId: async () => undefined,
    },
    flows: {
      list: async () => ({ data: [], next: null, previous: null }),
      current: {
        id: 'test-flow-id',
        version: {
          id: 'test-flow-version-id',
        },
      },
    },
    step: {
      name: 'test-step',
    },
    generateResumeUrl: () => 'http://localhost:3000/resume',
  } as unknown as ToolContext<undefined, Props>;
}
