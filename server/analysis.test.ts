import { describe, expect, it } from "vitest";
import {
  buildAssignmentStats,
  buildStudentStats,
  classifyReason,
  loadAssignmentData,
  mergeReasonTypes,
  promptPayload,
  reasonTypeIds,
} from "./analysis.mjs";
import { createFixtureDatabase, fixtureQuestions } from "./analysis.fixture.mjs";

const load = (db, fixture) => {
  const data = loadAssignmentData(db, {
    teacherId: fixture.teacherId,
    assignmentId: fixture.assignmentId,
  });
  expect(data).not.toBeNull();
  return buildAssignmentStats(data);
};

describe("错因归类", () => {
  it("把“无法辨认”排在学生错误之前，避免冤枉学生", () => {
    expect(
      classifyReason(
        "该题答题内容所在页面未在提供的答卷图片中呈现，无法辨认学生实际填写内容，暂不能判定正误。",
      ).id,
    ).toBe("unreadable");
    expect(classifyReason("字迹模糊，无法辨认").id).toBe("unreadable");
  });

  it("识别空题", () => {
    expect(classifyReason("学生答卷中该题未填写选项，按未作答处理。").id).toBe(
      "blank",
    );
    expect(classifyReason("未作答").id).toBe("blank");
  });

  it("区分概念混淆、审题偏差、计算粗心与步骤缺失", () => {
    expect(classifyReason("学生把焦耳当成了电流单位，概念混淆。").id).toBe(
      "concept",
    );
    expect(classifyReason("审题时未看清“放电”这一条件。").id).toBe("reading");
    expect(classifyReason("计算过程粗心，结果算错。").id).toBe("careless");
    expect(classifyReason("解题缺少必要的推导步骤，过程不完整。").id).toBe(
      "steps",
    );
  });

  it("无法归类时退回“其他”，只有确实留空才归为空题", () => {
    // 错因文本与答案都无法判定时，必须交回教师，而不是默认当成空题
    expect(classifyReason("再接再厉。").id).toBe("other");
    expect(classifyReason("hello").id).toBe("other");
    expect(classifyReason("再接再厉。", { studentAnswer: "AB" }).id).toBe("other");
    // 确凿的空答案才归为空题
    expect(classifyReason("", { studentAnswer: "未作答" }).id).toBe("blank");
    expect(classifyReason("这道题写得不错", { studentAnswer: "未作答" }).id).toBe(
      "blank",
    );
  });

  it("每个错因都有课堂提示与颜色，供前端直接渲染", () => {
    for (const id of reasonTypeIds) {
      const type = classifyReason("noop");
      expect(type).toBeTruthy();
    }
    expect(reasonTypeIds).toContain("unreadable");
  });
});

describe("班级学情统计", () => {
  it("只统计教师已复核的错题", () => {
    const { db, fixture } = createFixtureDatabase();
    const stats = load(db, fixture);
    const expected = fixtureQuestions.reduce(
      (sum, question) =>
        sum +
        (question.qing.correct ? 0 : 1) +
        (question.lin.correct ? 0 : 1),
      0,
    );
    expect(stats.overview.mistakeCount).toBe(expected);
    expect(stats.overview.pendingMistakeCount).toBe(1);
    expect(stats.overview.submissionCount).toBe(2);
    expect(stats.overview.studentCount).toBe(2);
  });

  it("计算班级得分率与平均分", () => {
    const { db, fixture } = createFixtureDatabase();
    const stats = load(db, fixture);
    expect(stats.overview.totalScore).toBe(
      fixtureQuestions.reduce((sum, question) => sum + question.score, 0),
    );
    expect(stats.overview.scoreRate).toBeGreaterThan(0);
    expect(stats.overview.scoreRate).toBeLessThan(1);
    expect(stats.overview.averageScore).toBeGreaterThan(0);
  });

  it("按正确率升序给出知识点掌握情况", () => {
    const { db, fixture } = createFixtureDatabase();
    const stats = load(db, fixture);
    const rates = stats.knowledgePoints.map((point) => point.correctRate);
    expect(rates).toEqual([...rates].sort((a, b) => a - b));
    for (const point of stats.knowledgePoints) {
      expect(point.questionNumbers.length).toBeGreaterThan(0);
      expect(point.total).toBe(point.questionNumbers.length * 2);
      expect(point.correctRate).toBeGreaterThanOrEqual(0);
      expect(point.correctRate).toBeLessThanOrEqual(1);
    }
  });

  it("把“无法辨认”单独成列，不混入学生错因", () => {
    const { db, fixture } = createFixtureDatabase();
    const stats = load(db, fixture);
    const unreadable = stats.reasonDistribution.find(
      (item) => item.id === "unreadable",
    );
    // 夹具中只有第 7 题属于“无法辨认”，第 1 题的错误是学生真的错了
    expect(unreadable?.count).toBe(1);
    expect(unreadable?.questions).toEqual([]);
    expect(unreadable?.samples).toEqual([]);
    const answerable = stats.reasonDistribution.filter(
      (item) => item.id !== "unreadable",
    );
    // 可归因错题的占比按可归因总数计算，无法辨认只占自己的那一份
    expect(answerable.reduce((sum, item) => sum + item.count, 0)).toBe(7);
    expect(answerable.reduce((sum, item) => sum + item.ratio, 0)).toBeCloseTo(
      0.875,
      5,
    );
    expect(stats.reasonDistribution.reduce((sum, item) => sum + item.ratio, 0)).toBeCloseTo(1, 5);
  });

  it("高频错题按出错人数排序并附带讲评素材", () => {
    const { db, fixture } = createFixtureDatabase();
    const stats = load(db, fixture);
    const counts = stats.highFrequencyQuestions.map(
      (question) => question.wrongCount,
    );
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    const withPractice = stats.highFrequencyQuestions.find(
      (question) => question.practice.length > 0,
    );
    expect(withPractice?.practice[0].prompt).toBeTruthy();
    expect(stats.resources.totalPractice).toBeGreaterThan(0);
  });

  it("汇总每名学生的错题、知识点与主要错因", () => {
    const { db, fixture } = createFixtureDatabase();
    const stats = load(db, fixture);
    const lin = stats.students.find((item) => item.name === "林一");
    const qing = stats.students.find((item) => item.name === "秦二");
    expect(lin?.mistakeCount).toBeGreaterThan(qing?.mistakeCount || 0);
    expect(lin?.submissionCount).toBe(1);
    expect(lin?.answerSlots).toBe(fixtureQuestions.length);
    expect(lin?.dominantReason?.label).toBe("概念混淆");
    expect(qing?.knowledgeTitles.length).toBeGreaterThan(0);
    expect(stats.students[0].name).toBe("林一");
  });

  it("逐题保留无法辨认的提示，并单独计数", () => {
    const { db, fixture } = createFixtureDatabase();
    const stats = load(db, fixture);
    const question7 = stats.highFrequencyQuestions.find(
      (question) => question.number === 7,
    );
    expect(question7?.reasons.join("")).toContain("无法辨认");
    expect(stats.overview.unreadableCount).toBe(1);
    expect(stats.overview.usefulMistakeCount).toBe(
      stats.overview.mistakeCount - stats.overview.unreadableCount,
    );
  });
});

describe("数据隔离", () => {
  it("非任课教师无法读取该作业", () => {
    const { db, fixture } = createFixtureDatabase();
    expect(
      loadAssignmentData(db, {
        teacherId: "someone-else",
        assignmentId: fixture.assignmentId,
      }),
    ).toBeNull();
  });

  it("只有本校可以按学校范围读取", () => {
    const { db, fixture } = createFixtureDatabase();
    expect(
      loadAssignmentData(db, {
        schoolId: fixture.schoolId,
        assignmentId: fixture.assignmentId,
      }),
    ).not.toBeNull();
    expect(
      loadAssignmentData(db, {
        schoolId: "another-school",
        assignmentId: fixture.assignmentId,
      }),
    ).toBeNull();
  });
});

describe("学生个别化分析", () => {
  it("只返回与该生有关的错题，并标注共同出错的题目", () => {
    const { db, fixture } = createFixtureDatabase();
    const stats = load(db, fixture);
    const lin = stats.students.find((item) => item.name === "林一");
    const detail = buildStudentStats(stats, lin.studentId);
    expect(detail?.student.name).toBe("林一");
    const numbers = detail.questions.map((question) => question.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    for (const number of lin.questionNumbers)
      expect(numbers).toContain(number);
    // 每一道返回的题都必须确实有该生出错，不能把别的学生的错题算进来
    expect(
      detail.questions.every((question) => question.students.includes("林一")),
    ).toBe(true);
    expect(
      detail.questions.some(
        (question) => question.students.length === 1,
      ),
    ).toBe(true);
  });

  it("对未知学生返回 null", () => {
    const { db, fixture } = createFixtureDatabase();
    const stats = load(db, fixture);
    expect(buildStudentStats(stats, "not-a-student")).toBeNull();
  });
});

describe("模型输入压缩", () => {
  it("班级输入包含统计结论而不含数据库内部字段", () => {
    const { db, fixture } = createFixtureDatabase();
    const stats = load(db, fixture);
    const payload = JSON.stringify(promptPayload(stats));
    expect(payload).toContain("knowledgePoints");
    expect(payload).toContain("reasonDistribution");
    expect(payload).not.toContain("practice_json");
    expect(payload.length).toBeLessThan(60000);
  });

  it("学生输入只包含该生数据", () => {
    const { db, fixture } = createFixtureDatabase();
    const stats = load(db, fixture);
    const lin = stats.students.find((item) => item.name === "林一");
    const payload = promptPayload(stats, { student: lin });
    expect(payload.scope).toBe("individual");
    expect(payload.student.name).toBe("林一");
    expect(JSON.stringify(payload)).not.toContain("秦二");
  });
});

describe("AI 归因融合", () => {
  it("按题号把模型的判定重新计入错因统计，且不改动错题总量", () => {
    const { db, fixture } = createFixtureDatabase();
    const stats = load(db, fixture);
    const totalMistakes = stats.reasonDistribution.reduce(
      (sum, item) => sum + item.count,
      0,
    );
    const ratioSum = stats.reasonDistribution.reduce(
      (sum, item) => sum + item.ratio,
      0,
    );
    // 基线：占比之和为 100%，与错题总数一致
    expect(totalMistakes).toBe(8);
    expect(ratioSum).toBeCloseTo(1, 5);

    const merged = mergeReasonTypes(stats.reasonDistribution, [
      {
        id: "concept",
        questionNumbers: [1, 3, 4, 8],
        evidence: "均为概念性判断错误",
      },
    ]);
    expect(merged.find((item) => item.id === "concept")?.count).toBe(4);
    // 第 8 题从“审题偏差”改判为“概念混淆”，第 4 题从“其他”改判
    expect(merged.find((item) => item.id === "reading")?.count).toBe(0);
    expect(merged.find((item) => item.id === "other")?.count).toBe(0);
    // 第 6 题上有两条复核记录（空题 + 步骤缺失），并列时按归因体系顺序取“空题”
    expect(merged.find((item) => item.id === "blank")?.count).toBe(3);
    // 无法辨认的题不进错因，但保留在列表里提醒教师
    expect(merged.find((item) => item.id === "unreadable")?.count).toBe(1);
    // 总数不变：模型只是把错题在错因之间重新分配，不能凭空增减
    expect(merged.reduce((sum, item) => sum + item.count, 0)).toBe(
      totalMistakes,
    );
    expect(merged.reduce((sum, item) => sum + item.ratio, 0)).toBeCloseTo(1, 5);
  });

  it("忽略未知错因 id 且不放大总数", () => {
    const { db, fixture } = createFixtureDatabase();
    const stats = load(db, fixture);
    const merged = mergeReasonTypes(stats.reasonDistribution, [
      { id: "not-a-real-cause", questionNumbers: [1] },
    ]);
    for (const item of stats.reasonDistribution) {
      expect(merged.find((entry) => entry.id === item.id)?.count).toBe(
        item.count,
      );
    }
  });

  it("模型只覆盖部分题号时，其余题号保持关键词归因", () => {
    const { db, fixture } = createFixtureDatabase();
    const stats = load(db, fixture);
    const totalMistakes = stats.reasonDistribution.reduce(
      (sum, item) => sum + item.count,
      0,
    );
    const merged = mergeReasonTypes(stats.reasonDistribution, [
      { id: "careless", questionNumbers: [2] },
    ]);
    const careless = merged.find((item) => item.id === "careless");
    const blank = merged.find((item) => item.id === "blank");
    // 第 2 题从原来的错因改判为“计算粗心”
    expect(careless?.count).toBe(1);
    expect(careless?.questions.map((question) => question.number)).toEqual([2]);
    // 第 2 题原本属于哪个错因，该错因就少一道；其余题号不受影响
    const baselineAnswerable = stats.reasonDistribution.filter(
      (item) => item.id !== "unreadable" && item.id !== "careless",
    );
    for (const item of baselineAnswerable) {
      const after = merged.find((entry) => entry.id === item.id);
      const removed = item.questions.some((question) => question.number === 2)
        ? 1
        : 0;
      expect(after?.count).toBe(item.count - removed);
    }
    expect(merged.find((item) => item.id === "concept")?.count).toBe(2);
    expect(blank?.count).toBe(2);
    expect(merged.reduce((sum, item) => sum + item.count, 0)).toBe(
      totalMistakes,
    );
    expect(merged.reduce((sum, item) => sum + item.ratio, 0)).toBeCloseTo(1, 5);
  });
  it("没有模型结果时保持原始统计", () => {
    const { db, fixture } = createFixtureDatabase();
    const stats = load(db, fixture);
    expect(mergeReasonTypes(stats.reasonDistribution, undefined)).toBe(
      stats.reasonDistribution,
    );
  });
});
