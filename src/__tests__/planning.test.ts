import {Plan, plan, AxidrawFast, XYMotion, PenMotion, Device} from '../planning';
import {Vec2} from '../vec';

describe("plan", () => {
  const device = Device()
  const profile = AxidrawFast
  it.skip("handles an empty input", () => {
    expect(plan([], profile, device)).toEqual(new Plan([], device.penPctToPos(0)))
  });

  function xyMotions(plan: Plan) {
    let curPenPos = 0;
    const motions: {from: Vec2; to: Vec2; penPos: number}[] = [];
    for (const m of plan.motions) {
      if (m instanceof PenMotion) {
        curPenPos = m.finalPos;
      } else if (m instanceof XYMotion) {
        motions.push({from: m.p1, to: m.p2, penPos: curPenPos});
      }
    }
    return motions;
  }

  it("handles a single point input", () => {
    const p = plan([[{x: 10, y: 10}]], profile, device);

    expect(xyMotions(p)).toEqual([
      {from: {x: 0, y: 0}, to: {x: 10, y: 10}, penPos: 0},
      {from: {x: 10, y: 10}, to: {x: 10, y: 10}, penPos: profile.penDownPos},
      {from: {x: 10, y: 10}, to: {x: 0, y: 0}, penPos: device.penPctToPos(0)},
    ]);
  });

  it("handles a line", () => {
    const p = plan([[{x: 10, y: 10}, {x: 20, y: 10}]], profile, device);

    expect(xyMotions(p)).toEqual([
      {from: {x: 0, y: 0}, to: {x: 10, y: 10}, penPos: 0},
      {from: {x: 10, y: 10}, to: {x: 20, y: 10}, penPos: profile.penDownPos},
      {from: {x: 20, y: 10}, to: {x: 0, y: 0}, penPos: device.penPctToPos(0)},
    ]);
  });

  it("handles two lines", () => {
    const p = plan([
      [{x: 10, y: 10}, {x: 20, y: 10}],
      [{x: 10, y: 20}, {x: 20, y: 20}],
    ], profile, device);

    expect(xyMotions(p)).toEqual([
      {from: {x: 0, y: 0}, to: {x: 10, y: 10}, penPos: 0},
      {from: {x: 10, y: 10}, to: {x: 20, y: 10}, penPos: profile.penDownPos},
      {from: {x: 20, y: 10}, to: {x: 10, y: 20}, penPos: profile.penUpPos},
      {from: {x: 10, y: 20}, to: {x: 20, y: 20}, penPos: profile.penDownPos},
      {from: {x: 20, y: 20}, to: {x: 0, y: 0}, penPos: device.penPctToPos(0)},
    ]);
  });

  it("shouldn't slow down for a fake point", () => {
    const p1 = plan([
      [{x: 10, y: 10}, {x: 30, y: 10}],
    ], profile, device);
    const p2 = plan([
      [{x: 10, y: 10}, {x: 25, y: 10}, {x: 30, y: 10}],
    ], profile, device);

    expect(p1.motions[2].duration()).toEqual(p2.motions[2].duration());
  })
});
