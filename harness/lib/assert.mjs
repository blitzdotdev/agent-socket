// Tiny assertion helper with structured failure output.
//
// Each scenario builds up a "trace" of steps; on failure it prints the
// expected vs actual + the recent wrangler.log slice.

export class Assert {
  constructor(scenarioName) {
    this.name = scenarioName
    this.steps = []
    this.startedAt = Date.now()
  }

  /** Mark a passed step. */
  pass(stepName) {
    this.steps.push({ ok: true, step: stepName })
  }

  /**
   * Assert a condition. If false, throws with structured info.
   * extra is a free-form object printed on failure.
   */
  ok(condition, stepName, extra = {}) {
    if (condition) {
      this.steps.push({ ok: true, step: stepName })
      return
    }
    const err = new HarnessFailure(stepName, extra)
    err.scenario = this.name
    throw err
  }

  /** Compare deepEqual-ish (JSON-roundtrip). */
  equal(actual, expected, stepName) {
    const ja = JSON.stringify(actual)
    const je = JSON.stringify(expected)
    if (ja === je) {
      this.steps.push({ ok: true, step: stepName })
      return
    }
    throw new HarnessFailure(stepName, { actual, expected })
  }

  durationMs() {
    return Date.now() - this.startedAt
  }
}

export class HarnessFailure extends Error {
  constructor(stepName, extra) {
    super(`step failed: ${stepName}`)
    this.stepName = stepName
    this.extra = extra
  }
}
