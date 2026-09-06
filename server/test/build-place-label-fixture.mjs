// Emit an isolated Luau test script for the plugin's actual display-label block.
// From the repo root: node server/test/build-place-label-fixture.mjs > place-label-test.luau
// Run the emitted source with the Studio MCP run_luau tool in Edit mode.
// Require LABEL_SUMMARY 9 0. It mocks metadata/tasks and does not mutate the game.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const plugin = readFileSync(new URL('../../plugin/MultiAIPlugin.lua', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('./place-label.fixture.luau', import.meta.url), 'utf8');
const start = plugin.indexOf('-- Advisory display label');
const end = plugin.indexOf('-- Optional shared secret.', start);
assert(start >= 0 && end > start, 'Plugin label extraction boundaries changed');
assert.equal(fixture.split('SOURCE_BLOCK').length, 2, 'Fixture must contain one insertion point');
process.stdout.write(fixture.replace('SOURCE_BLOCK', plugin.slice(start, end)));
