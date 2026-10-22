
/* eslint-disable @typescript-eslint/no-explicit-any */
import { IntegrationProperty } from '@inboxfm-connect/pieces-framework'

export type ProcessorFn<INPUT = any, OUTPUT = any> = (
    property: IntegrationProperty,
    value: INPUT,
) => OUTPUT
