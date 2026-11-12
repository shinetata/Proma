import { expect, test } from 'bun:test'
import { getBuiltinMcpDefinitions, RESERVED_BUILTIN_KEYS } from './baseline'

test('Given legacy search and image tools are removed When listing integrated MCP capabilities Then only Proma Cloud is exposed and runtime names stay reserved', () => {
  const definitions = getBuiltinMcpDefinitions()
  expect(definitions.map((item) => item.id)).toEqual(['proma-cloud'])
  expect(definitions[0]?.tools.map((tool) => tool.name)).toEqual(['WebSearch', 'WebFetch'])
  expect(RESERVED_BUILTIN_KEYS).toEqual(new Set(['proma-cloud', 'proma_cloud', 'automation', 'collaboration']))
})
