import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { EntitySchema } from 'typeorm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { getEntities } from '../../../../src/app/database/database-connection'

function findEntityFiles(appDir: string): string[] {
    const entries = fs.readdirSync(appDir, { recursive: true })
    const entityFiles: string[] = []

    for (const entry of entries) {
        const fileStr = String(entry)
        if (
            !fileStr.endsWith('.ts') ||
            fileStr.endsWith('.d.ts') ||
            fileStr.includes('migration') ||
            fileStr.includes('.test.ts') ||
            fileStr.includes('.spec.ts')
        ) {
            continue
        }

        const fullPath = path.join(appDir, fileStr)
        const content = fs.readFileSync(fullPath, 'utf-8')
        if (fileStr.endsWith('.entity.ts') || fileStr.endsWith('-entity.ts') || containsEntityConstructor(content)) {
            entityFiles.push(fullPath)
        }
    }

    return entityFiles
}

function containsEntityConstructor(content: string): boolean {
    const source = ts.createSourceFile('entity.ts', content, ts.ScriptTarget.Latest, true)
    const constructors = new Set<string>()
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'typeorm') continue
        const bindings = statement.importClause?.namedBindings
        if (!bindings || !ts.isNamedImports(bindings)) continue
        for (const binding of bindings.elements) {
            if ((binding.propertyName ?? binding.name).text === 'EntitySchema') constructors.add(binding.name.text)
        }
    }
    function contains(node: ts.Node): boolean {
        return (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && constructors.has(node.expression.text)) || ts.forEachChild(node, contains) === true
    }
    return contains(source)
}

async function discoverEntities(appDir: string): Promise<DiscoveredEntity[]> {
    const files = findEntityFiles(appDir)
    const discovered: DiscoveredEntity[] = []

    for (const filePath of files) {
        const mod = await import(pathToFileURL(filePath).href)
        const relativePath = path.relative(appDir, filePath).replace(/\\/g, '/')

        for (const [exportName, exportedVal] of Object.entries(mod)) {
            if (exportedVal instanceof EntitySchema) {
                discovered.push({
                    exportName,
                    entity: exportedVal,
                    filePath,
                    relativePath,
                })
            }
        }
    }

    return discovered
}

function checkEntityRegistrations({ discoveredEntities, registeredEntities }: {
    discoveredEntities: DiscoveredEntity[]
    registeredEntities: EntitySchema<unknown>[]
}): { missing: DiscoveredEntity[], duplicates: string[] } {
    const registeredNames = new Set(registeredEntities.map((e) => e.options.name))
    const missing: DiscoveredEntity[] = []

    for (const discovered of discoveredEntities) {
        const isRegisteredByName = registeredNames.has(discovered.entity.options.name)
        if (!isRegisteredByName) {
            missing.push(discovered)
        }
    }

    const seenNames = new Set<string>()
    const duplicates: string[] = []
    for (const entity of registeredEntities) {
        if (seenNames.has(entity.options.name)) {
            duplicates.push(entity.options.name)
        }
        seenNames.add(entity.options.name)
    }

    return { missing, duplicates }
}

function buildMissingEntitiesMessage(missing: DiscoveredEntity[]): string {
    const missingDetails = missing
        .map(
            (m) =>
                `  - Entity '${m.entity.options.name}' (export '${m.exportName}') in src/app/${m.relativePath}`,
        )
        .join('\n')

    const fixInstructions = missing
        .map(
            (m) =>
                `    import { ${m.exportName} } from '../${m.relativePath.replace(/\.ts$/, '')}'`,
        )
        .join('\n')

    return (
        `Found ${missing.length} entity file(s) missing from getEntities() in packages/server/api/src/app/database/database-connection.ts:\n` +
        `${missingDetails}\n\n` +
        'Fix:\n' +
        '1. Open packages/server/api/src/app/database/database-connection.ts\n' +
        `2. Import the missing entity schema(s):\n${fixInstructions}\n` +
        '3. Add the exported entity schema(s) to the array returned by getEntities().'
    )
}

describe('Entity Registration Regression Suite (Issue #142)', () => {
    const appDir = path.resolve(__dirname, '../../../../src/app')

    it('recognizes aliased constructors without matching comments or unrelated classes', () => {
        expect(containsEntityConstructor("import { EntitySchema as ES } from 'typeorm'; export const Example = new ES({ name: 'example' })")).toBe(true)
        expect(containsEntityConstructor('// new EntitySchema({})')).toBe(false)
        expect(containsEntityConstructor('class EntitySchema {}; new EntitySchema()')).toBe(false)
    })

    it('identifies duplicate names and accepts the registered entity by its TypeORM name', () => {
        const createSchema = () => new EntitySchema({ name: 'example', columns: { id: { type: 'varchar', primary: true } } })
        const registered = createSchema()
        const discovery = { entity: createSchema(), exportName: 'Example', filePath: '/example.entity.ts', relativePath: 'example.entity.ts' }
        expect(checkEntityRegistrations({ discoveredEntities: [discovery], registeredEntities: [registered] })).toEqual({ missing: [], duplicates: [] })
        expect(checkEntityRegistrations({ discoveredEntities: [discovery], registeredEntities: [registered, registered] }).duplicates).toEqual(['example'])
    })

    it('scans src/app/**/*.entity.ts and asserts every EntitySchema is in getEntities()', async () => {
        const discovered = await discoverEntities(appDir)
        const registered = getEntities()

        expect(discovered.length).toBeGreaterThan(0)
        expect(registered.length).toBeGreaterThan(0)

        const { missing, duplicates } = checkEntityRegistrations({ discoveredEntities: discovered, registeredEntities: registered })

        if (missing.length > 0) {
            expect.fail(buildMissingEntitiesMessage(missing))
        }

        expect(duplicates, `Duplicate entity registrations found in getEntities(): ${duplicates.join(', ')}`).toHaveLength(0)
    })

    it('asserts failure diagnostics report missing entities and actionable fix instructions', () => {
        const fakeEntity = new EntitySchema({
            name: 'unregistered_test_entity',
            tableName: 'unregistered_test_entity',
            columns: {
                id: { type: 'varchar', primary: true },
            },
        })

        const fakeDiscovered: DiscoveredEntity[] = [
            {
                exportName: 'UnregisteredTestEntity',
                entity: fakeEntity,
                filePath: '/mock/src/app/test/unregistered.entity.ts',
                relativePath: 'test/unregistered.entity.ts',
            },
        ]

        const registered = getEntities()
        const { missing } = checkEntityRegistrations({ discoveredEntities: fakeDiscovered, registeredEntities: registered })

        expect(missing).toHaveLength(1)
        expect(missing[0].exportName).toBe('UnregisteredTestEntity')
        expect(missing[0].entity.options.name).toBe('unregistered_test_entity')

        const message = buildMissingEntitiesMessage(missing)
        expect(message).toContain("Entity 'unregistered_test_entity' (export 'UnregisteredTestEntity') in src/app/test/unregistered.entity.ts")
        expect(message).toContain("import { UnregisteredTestEntity } from '../test/unregistered.entity'")
        expect(message).toContain('Open packages/server/api/src/app/database/database-connection.ts')
        expect(message).toContain('Add the exported entity schema(s) to the array returned by getEntities().')
    })
})

type DiscoveredEntity = {
    exportName: string
    entity: EntitySchema<unknown>
    filePath: string
    relativePath: string
}
