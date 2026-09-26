import { api, json } from "./api";

/** 教学分析模块的全部类型与请求封装，供 src/main.tsx 中的教学分析面板使用。 */

export type ReasonEntry = {
  id: string;
  label: string;
  short: string;
  color: string;
  hint: string;
  count: number;
  ratio: number;
  samples: string[];
  questions: { number: number; count: number; prompt: string }[];
};

export type KnowledgeEntry = {
  id: string;
  title: string;
  questionNumbers: number[];
  errorCount: number;
  students: string[];
  total: number;
  correctRate: number;
};

export type QuestionEntry = {
  id: string;
  number: number;
  prompt: string;
  standardAnswer: string;
  knowledgeId: string;
  knowledgeTitle: string;
  score: number;
  wrongCount: number;
  students: string[];
  reasons: string[];
  corrections: string[];
  explanations: string[];
  practice: { prompt: string; answer: string; explanation: string }[];
  errorRate: number;
};

export type StudentEntry = {
  studentId: string;
  name: string;
  mistakeCount: number;
  submissionCount: number;
  answerSlots: number;
  questionNumbers: number[];
  knowledgeIds: string[];
  knowledgeTitles: string[];
  reasons: string[];
  missingWork: number;
  errorRate: number;
  score: number | null;
  dominantReason: { id: string; label: string; color: string } | null;
};

export type TeachingStats = {
  assignment: {
    id: string;
    title: string;
    stage: string;
    subject: string;
    className: string;
    createdAt: string;
    questionCount: number;
    totalScore: number;
  };
  overview: {
    submissionCount: number;
    studentCount: number;
    reviewedCount: number;
    pendingCount: number;
    submissionTotal: number;
    questionCount: number;
    totalScore: number;
    mistakeCount: number;
    errorRate: number;
    scoreRate: number;
    averageScore: number;
    unreadableCount: number;
    usefulMistakeCount: number;
    pendingMistakeCount: number;
    multipleSubmissions: boolean;
  };
  knowledgePoints: KnowledgeEntry[];
  reasonDistribution: ReasonEntry[];
  highFrequencyQuestions: QuestionEntry[];
  students: StudentEntry[];
  resources: {
    knowledgePoints: {
      knowledgeId: string;
      title: string;
      questionNumbers: number[];
      explanations: string[];
      practice: { prompt: string; answer: string; explanation: string }[];
    }[];
    totalPractice: number;
  };
};

export type ClassAnalysis = {
  brief?: string;
  keyFindings?: { title: string; detail: string; action: string }[];
  boardPlan?: {
    title?: string;
    duration?: string;
    goal?: string;
    steps?: { minutes: number; title: string; teacher: string; students: string }[];
    blackboard?: string[];
  };
  questionReviews?: {
    number: number;
    knowledge: string;
    whyWrong: string;
    explainToStudents: string;
    boardWork: string;
    quickCheck: string;
    wrongStudents?: string[];
  }[];
  reasonInsights?: {
    id: string;
    label: string;
    diagnosis: string;
    teachingMove: string;
    followUp: string;
  }[];
  groups?: {
    name: string;
    studentNames: string[];
    strategy: string;
    materials: string;
  }[];
  homework?: {
    title: string;
    targets?: string[];
    items?: {
      prompt: string;
      source: string;
      difficulty: string;
      expectation: string;
    }[];
  };
  teacherScript?: string;
};

export type StudentAnalysis = {
  brief?: string;
  diagnosis?: string;
  weakKnowledge?: {
    title: string;
    questionNumbers: number[];
    evidence: string;
    mastery: string;
  }[];
  causes?: { label: string; detail: string; fix: string }[];
  actions?: { when: string; what: string; who: string; check: string }[];
  practice?: {
    prompt: string;
    knowledge: string;
    answer: string;
    difficulty: string;
  }[];
  encouragement?: string;
  parentNote?: string;
};

export type StoredAnalysis<T> = {
  id: string;
  model: string;
  created_at: string;
  content: T;
};

export type TeachingAssignment = {
  id: string;
  title: string;
  stage: string;
  subject: string;
  class_name: string;
  created_at: string;
  teacher_name?: string;
  question_count: number;
  mistake_count: number;
  analysis: { created_at: string; model: string } | null;
};

export type FocusEntry = {
  student_id: string;
  level: "watch" | "follow" | "priority";
  note: string;
};

export const focusLevels = [
  { id: "watch", label: "观察", hint: "本轮先记录，不单独辅导" },
  { id: "follow", label: "跟进", hint: "课后个别提醒与订正" },
  { id: "priority", label: "重点", hint: "课堂上优先关照，必要时面批" },
] as const;

export type StudentDetail = {
  student: StudentEntry;
  questions: QuestionEntry[];
  knowledgePoints: KnowledgeEntry[];
  reasons: ReasonEntry[];
  analysis: StoredAnalysis<StudentAnalysis> | null;
};

export const listTeachingAssignments = () =>
  api<TeachingAssignment[]>("/teaching/assignments");

export const loadTeachingAnalysis = (assignmentId: string) =>
  api<{
    stats: TeachingStats;
    analysis: StoredAnalysis<ClassAnalysis> | null;
    focus: FocusEntry[];
    history: { id: string; model: string; created_at: string }[];
  }>(`/teaching/assignments/${assignmentId}`);

export const generateClassAnalysis = (assignmentId: string) =>
  api<{ analysis: StoredAnalysis<ClassAnalysis>; stats: TeachingStats }>(
    `/teaching/assignments/${assignmentId}/analyze`,
    { method: "POST" },
  );

export const refineReasonTypes = (assignmentId: string) =>
  api<{ reasonDistribution: ReasonEntry[] }>(
    `/teaching/assignments/${assignmentId}/reasons`,
    { method: "POST" },
  );

export const loadStudentAnalysis = (assignmentId: string, studentId: string) =>
  api<StudentDetail>(
    `/teaching/assignments/${assignmentId}/students/${encodeURIComponent(studentId)}`,
  );

export const generateStudentAnalysis = (
  assignmentId: string,
  studentId: string,
) =>
  api<{ analysis: StoredAnalysis<StudentAnalysis> }>(
    `/teaching/assignments/${assignmentId}/students/${encodeURIComponent(studentId)}/analyze`,
    { method: "POST" },
  );

export const saveFocus = (
  assignmentId: string,
  studentId: string,
  payload: { level: string; note?: string },
) =>
  api<{ ok: boolean; level: string | null }>(
    `/teaching/assignments/${assignmentId}/focus/${encodeURIComponent(studentId)}`,
    json("PUT", payload),
  );

export const mistakesToAssignment = (
  assignmentId: string,
  payload: { numbers: number[]; title?: string },
) =>
  api<{
    id: string;
    title: string;
    questionCount: number;
    knowledgePoints: string[];
  }>(`/teaching/assignments/${assignmentId}/mistakes-to-assignment`, json("POST", payload));
