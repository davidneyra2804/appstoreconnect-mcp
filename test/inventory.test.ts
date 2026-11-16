/**
 * Inventory invariant.
 *
 * The read-only guarantee of this server rests on a single file: the tool
 * inventory in `src/tools.ts`. This suite locks that guarantee, so a write
 * capability cannot enter the server by accident.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  APP_SCOPED_TOOLS,
  TOOLS,
  TOOL_NAMES,
  WRITE_VERB_PREFIXES,
  isWriteToolName,
} from '../src/tools.js';

describe('tool inventory invariant', () => {
  it('exposes no write tool', () => {
    const writeTools = TOOLS.filter((tool) => isWriteToolName(tool.name));

    assert.deepEqual(
      writeTools.map((tool) => tool.name),
      [],
      'The inventory must not contain a tool whose name looks like a mutation',
    );
  });

  it('has no duplicate tool name', () => {
    const names = TOOLS.map((tool) => tool.name);
    const unique = new Set(names);

    assert.equal(unique.size, names.length, `Duplicate tool name in: ${names.join(', ')}`);
  });

  it('gives every tool a description and a schema', () => {
    for (const tool of TOOLS) {
      assert.ok(tool.description.length > 0, `Tool ${tool.name} has no description`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  });

  it('declares the required arguments of every tool', () => {
    for (const tool of TOOLS) {
      for (const key of tool.inputSchema.required ?? []) {
        assert.ok(
          tool.inputSchema.properties[key],
          `Tool ${tool.name} requires "${key}" but does not declare it`,
        );
      }
    }
  });

  it('only scopes a tool by app when the tool takes an app id', () => {
    for (const name of APP_SCOPED_TOOLS) {
      const tool = TOOLS.find((candidate) => candidate.name === name);
      assert.ok(tool, `The scoped tool ${name} is not in the inventory`);
      assert.ok(
        tool.inputSchema.properties.appId,
        `The scoped tool ${name} does not take an app id`,
      );
      assert.ok(
        (tool.inputSchema.required ?? []).includes('appId'),
        `The scoped tool ${name} does not require an app id`,
      );
    }
  });

  it('exposes exactly the names of the inventory', () => {
    assert.deepEqual(TOOL_NAMES, TOOLS.map((tool) => tool.name));
  });
});

describe('write name detection', () => {
  it('recognises a mutation verb', () => {
    for (const prefix of WRITE_VERB_PREFIXES) {
      assert.equal(isWriteToolName(`${prefix}_something`), true);
      assert.equal(isWriteToolName(prefix.toUpperCase()), true);
    }
  });

  it('does not flag a read tool', () => {
    for (const name of TOOL_NAMES) {
      assert.equal(isWriteToolName(name), false, `The read tool ${name} was flagged as a write`);
    }
  });

  it('does not flag a tool whose name merely contains a verb', () => {
    assert.equal(isWriteToolName('list_customer_reviews'), false);
    assert.equal(isWriteToolName('get_sales_report'), false);
  });
});
