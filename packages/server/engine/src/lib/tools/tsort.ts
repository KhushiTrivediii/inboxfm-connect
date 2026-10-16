import { PiecePropertyMap } from '@inboxfm-connect/pieces-framework'

export const tsort = {
    sortPropertiesByDependencies(properties: PiecePropertyMap): Record<number, string[]> {
        const inDegree: Record<string, number> = {}
        const graph: Record<string, string[]> = {}
        const depth: Record<string, number> = {}

        Object.entries(properties).forEach(([key, property]) => {
            const hasRefreshers = 'refreshers' in property && property.refreshers && Array.isArray(property.refreshers) && property.refreshers.length > 0
            if (hasRefreshers) {
                for (const refresher of property.refreshers) {
                    if (typeof properties[refresher] === 'undefined' || properties[refresher] === null) {
                        continue
                    }
                    inDegree[key] = (inDegree[key] || 0) + 1
                    graph[refresher] = graph[refresher] ?? []
                    graph[refresher].push(key)
                }
            }
            inDegree[key] = inDegree[key] ?? 0
            graph[key] = graph[key] ?? []
        })

        // Topological sort
        const order: string[] = []
        const queue = Object.entries(inDegree)
            .filter(([, degree]) => degree === 0)
            .map(([name]) => name)

        queue.forEach(property => depth[property] = 0)

        while (queue.length > 0) {
            const current = queue.shift()!
            order.push(current)

            const neighbors = graph[current] || []
            neighbors.forEach(neighbor => {
                inDegree[neighbor]--
                if (inDegree[neighbor] === 0) {
                    queue.push(neighbor)
                    depth[neighbor] = depth[current] + 1
                }
            })
        }

        const depthToPropertyMap: Record<number, string[]> = {}
        for (const [property, depthValue] of Object.entries(depth)) {
            depthToPropertyMap[depthValue] = depthToPropertyMap[depthValue] ?? []
            depthToPropertyMap[depthValue].push(property)
        }

        // Kahn's algorithm drops every property in (or downstream of) a refresher
        // cycle: their in-degree never reaches zero, so they never enter `depth`
        // and silently vanish from the extraction order — the tool would run with
        // those inputs missing. A cyclic dependency graph is a piece-authoring
        // mistake, not a reason to discard the props: collect the leftovers and
        // append them in a final bucket after every acyclic depth.
        const maxDepth = Object.values(depth).reduce((max, value) => Math.max(max, value), -1)
        const unvisited = Object.keys(inDegree).filter(name => depth[name] === undefined)
        if (unvisited.length > 0) {
            depthToPropertyMap[maxDepth + 1] = unvisited
        }

        return depthToPropertyMap
    },
}

