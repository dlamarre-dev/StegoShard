/**
 * The three rule families of `architecture:check`.
 *
 * The script runs green on every PR, which exercises its rules against the real
 * specification and never once against a broken one. That is precisely how a
 * guard rots: `checkSources` walking a shape it does not recognise and finding
 * nothing to check reports the same clean line as a diagram whose every link
 * resolves. The cases below pin the failure paths, because those are the only
 * ones CI will never reach on its own. Same reasoning as
 * tests/docs/check-claims.test.ts, which was written after the same gap.
 *
 * The case that matters most is `refuses to pass when a rule stops matching`. A
 * claim rule is anchored to wording, and wording is the thing most likely to be
 * edited for reasons that have nothing to do with the number. If a reworded label
 * made a rule match zero sites and the script called that agreement, the guard
 * would still be printing a confident line while checking nothing at all.
 */

import { describe, it, expect } from 'vitest';
import {
  checkSources,
  checkClaims,
  checkWiring,
  claimRules,
} from '../../scripts/check-architecture';

const always = (): boolean => true;
const never = (): boolean => false;

describe('source liveness', () => {
  it('passes when every cited path resolves', () => {
    const report = checkSources(
      { components: [{ id: 'core', sources: [{ path: 'src/core/vault.ts' }] }] },
      always,
    );
    expect(report.failures).toEqual([]);
    expect(report.checked).toBe(1);
  });

  it('names the node and the path when a citation is dead', () => {
    const report = checkSources(
      { components: [{ id: 'containers', sources: [{ path: 'src/core/gone.ts' }] }] },
      never,
    );
    expect(report.failures).toHaveLength(1);
    // The message has to carry both, or a reader has a broken path and no idea
    // which box promised it.
    expect(report.failures[0]).toContain('containers');
    expect(report.failures[0]).toContain('src/core/gone.ts');
  });

  it('counts every source of every node, not one per node', () => {
    const report = checkSources(
      {
        components: [
          { id: 'a', sources: [{ path: 'one.ts' }, { path: 'two.ts' }] },
          { id: 'b', sources: [{ path: 'three.ts' }] },
        ],
      },
      always,
    );
    expect(report.checked).toBe(3);
  });

  it('checks nothing rather than inventing something when nodes carry no sources', () => {
    // A specification with no source links is a real possibility (an early draft),
    // and the honest answer is zero checked, not zero failures dressed as a pass.
    expect(checkSources({ components: [{ id: 'a' }] }, never).checked).toBe(0);
    expect(checkSources({}, never)).toEqual({ failures: [], checked: 0 });
  });
});

describe('claim agreement', () => {
  const rule = (over: Partial<ReturnType<typeof claimRules>[number]> = {}) => [
    {
      id: 'format-version',
      pattern: /FORMAT_VERSION (\d+)/g,
      count: 1,
      expected: 2,
      source: 'FORMAT_VERSION in src/core/header.ts',
      ...over,
    },
  ];

  it('passes when the diagram states the constant the code holds', () => {
    const report = checkClaims('"tag": "FORMAT_VERSION 2"', rule());
    expect(report.failures).toEqual([]);
    expect(report.checked).toBe(1);
  });

  it('reports both numbers when they disagree', () => {
    const report = checkClaims('"tag": "FORMAT_VERSION 1"', rule());
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('says 1');
    expect(report.failures[0]).toContain('says 2');
  });

  it('refuses to pass when a rule stops matching', () => {
    // The wording moved and the rule now matches nothing. Zero mismatches is not
    // agreement; it is a rule that has quietly stopped being a rule.
    const report = checkClaims('"tag": "format v2"', rule());
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('found 0');
    expect(report.checked).toBe(0);
  });

  it('refuses to pass when a claim is duplicated into a new site', () => {
    // A second site is not harmless: it is a second place to forget. The count is
    // pinned in both directions for that reason.
    const report = checkClaims('FORMAT_VERSION 2 ... FORMAT_VERSION 2', rule());
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('found 2');
  });

  it('checks every site once the count is right', () => {
    const report = checkClaims('FORMAT_VERSION 2 ... FORMAT_VERSION 3', rule({ count: 2 }));
    expect(report.checked).toBe(2);
    expect(report.failures).toHaveLength(1);
  });

  it('derives the locale expectation from the count it is handed', () => {
    // Not from a literal in the script, which would be the second copy the whole
    // guard exists to avoid.
    const rules = claimRules(11);
    expect(rules.find((r) => r.id === 'locale-count')?.expected).toBe(11);
  });
});

describe('render wiring', () => {
  const linked = '| [Architecture diagram](docs/images/architecture.png) | ... |';

  it('passes when the picture exists and README links it', () => {
    expect(checkWiring(linked, always).failures).toEqual([]);
  });

  it('fails when the picture is missing', () => {
    const report = checkWiring(linked, never);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('does not exist');
  });

  it('fails when README stops linking it', () => {
    const report = checkWiring('no diagram row here', always);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('does not link');
  });

  it('does not accept a bare mention as a link', () => {
    // A path named in prose is not a row in the table. Matching on the closing
    // paren of the markdown link is what keeps those apart.
    const report = checkWiring('see docs/images/architecture.png for the map', always);
    expect(report.failures).toHaveLength(1);
  });
});
