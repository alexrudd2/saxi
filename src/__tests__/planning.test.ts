import {Plan, plan, profiles, PenMotion} from '../planning'
import { Vec2 } from '../vec'

describe("plan", () => {
  const profile = profiles.v3
  const up = profile.penUpPos
  const down = profile.penDownPos
  const origin = { x: 0, y: 0 }
  
  // We always start and end in the up position
  it.skip("handles an empty input", () => {
    expect(plan([], profile)).toEqual(new Plan([]))
  });

  // This turns a full Plan into simplified json for easier testing
  function motions(plan: Plan): Array<{pen: number}|{from: Vec2, to: Vec2}> {
    return plan
      .motions
      .map(motion => {
        if (motion instanceof PenMotion) return {pen: motion.finalPos}
        return {from: motion.p1, to: motion.p2}
      })
}

  it("handles a single point input", () => {
    const point = { x: 10, y: 10 }
    
    const singlePoint = plan([[point]], profile)
    
    expect(motions(singlePoint)).toEqual([
      {pen: up},
      {from: origin, to: point},
      {pen: down},
      {from: point, to: point},
      {pen: up},
      {from: point, to: origin},
    ])
  })

  it("handles a line", () => {
    const line = [{x: 10, y: 10}, {x: 20, y: 10}]
    const original = plan([line], profile);

    expect(motions(original)).toEqual([
      {pen: up},
      {from: origin, to: line[0]},
      {pen: down},
      {from: line[0], to: line[1]},
      {pen: up},
      {from: line[1], to: origin},
    ])
  })

  it("handles two lines", () => {
    const horizontal = [{x: 10, y: 10}, {x: 20, y: 10}]
    const vertical = [{x: 20, y: 10}, {x: 20, y: 20}]

    const twoLines = plan([horizontal, vertical], profile)
    console.log(motions(twoLines))
    expect(motions(twoLines)).toEqual([
      {pen: up},
      {from: origin, to: horizontal[0]},
      {pen: down},
      {from: horizontal[0], to: horizontal[1]},
      {pen: up}, // Will this be removed with joinLines Optimization?
      {from: horizontal[1], to: vertical[0]},
      {pen: down},
      {from: vertical[0], to: vertical[1]},
      {pen: up},
      {from: vertical[1], to: origin},
    ])
  })

  it("shouldn't slow down for a fake point", () => {
    const p1 = plan([
      [{x: 10, y: 10}, {x: 30, y: 10}],
    ], profile)
    const p2 = plan([
      [{x: 10, y: 10}, {x: 25, y: 10}, {x: 30, y: 10}],
    ], profile)

    expect(p1.motions[2].duration()).toEqual(p2.motions[2].duration())
  })
})
