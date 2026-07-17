/**
 * Test Lab API client — /api/admin/testlab/* (admin only).
 */
import { api } from './api';

export interface TestLabStory {
  id: string;
  title: string | null;
  artStyle: string | null;
  storyType: string | null;
  language: string | null;
  languageLevel: string | null;
  pages: number;
  userEmail: string | null;
  username: string | null;
  createdAt: string;
  hasBenchmark: boolean;
}

export interface TestLabPagination {
  page: number;
  limit: number;
  totalStories: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface BenchmarkScene {
  id: number;
  storyId: string;
  pageNumber: number;
  label: string | null;
  tags: {
    artStyle?: string;
    storyType?: string;
    language?: string;
    characterCount?: number;
    hasLandmark?: boolean;
  };
  snapshot: {
    title?: string;
    sceneDescription?: string;
    sceneText?: string;
    textPosition?: string;
    characterNames?: string[];
    snapshotAt?: string;
  };
  storyTitle: string | null;
  createdAt: string;
}

export interface ExperimentSummary {
  id: number;
  stage: string;
  label: string | null;
  status: string;
  hasOverride: boolean;
  targetCount: number;
  doneCount: number;
  createdBy: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ExperimentResult {
  storyId: string;
  pageNumber: number;
  character?: string;
  realisticVersionIndex?: number | null;
  finalScore?: number | null;
  ok: boolean;
  error?: string;
  imageType?: string;
  versionIndex?: number;
  promptUsed?: string;
  modelId?: string;
  elapsedMs?: number;
  scores?: {
    quality?: number | null;
    final?: number | null;
    semantic?: number | null;
    verdict?: string | null;
    issuesSummary?: string | null;
    error?: string;
  };
  issuesSummary?: string | null;
  fixableIssues?: unknown[];
  semanticIssues?: unknown[];
  figures?: { name?: string; bbox?: number[]; match?: unknown; confidence?: number }[];
  objects?: { name?: string; bbox?: number[] }[];
  detectionBackend?: string | null;
  report?: unknown;
  storedBaseline?: { qualityScore?: number | null; semanticScore?: number | null };
  characterName?: string;
  qc?: { pass?: boolean; issues?: string[]; visionFeedback?: string | null; error?: string };
  method?: string | null;
  backend?: string;
  repairMode?: string;
  artStyle?: string;
  pass?: number;
  redoOf?: number | string;
  redoneAt?: string;
  promptOverridden?: boolean;
}

export interface ExperimentDetail {
  id: number;
  stage: string;
  label: string | null;
  status: string;
  promptOverride: string | null;
  params: Record<string, unknown>;
  targets: { storyId: string; pageNumber: number }[];
  results: ExperimentResult[];
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  completedAt: string | null;
}

export const TESTLAB_STAGES = [
  { id: 'image', label: 'Page image', producesImage: true, overridable: true },
  { id: 'empty_scene', label: 'Empty scene', producesImage: true, overridable: true },
  { id: 'quality_eval', label: 'Quality eval', producesImage: false, overridable: true },
  { id: 'semantic_eval', label: 'Semantic eval', producesImage: false, overridable: true },
  { id: 'bbox', label: 'Bbox detection', producesImage: false, overridable: false },
  { id: 'char_repair', label: 'Character repair', producesImage: true, overridable: false },
  { id: 'entity', label: 'Entity consistency', producesImage: false, overridable: false },
] as const;

export const testlabService = {
  getStories(params: { page?: number; limit?: number; artStyle?: string; storyType?: string; language?: string; search?: string; days?: number } = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    });
    return api.get<{ stories: TestLabStory[]; pagination: TestLabPagination }>(`/api/admin/testlab/stories?${qs.toString()}`);
  },

  getTemplates() {
    return api.get<{ templates: Record<string, string | null> }>('/api/admin/testlab/templates');
  },

  getBenchmarks() {
    return api.get<{ benchmarks: BenchmarkScene[] }>('/api/admin/testlab/benchmark');
  },

  addBenchmark(storyId: string, pageNumber: number, label?: string) {
    return api.post<{ id: number }>('/api/admin/testlab/benchmark', { storyId, pageNumber, label });
  },

  deleteBenchmark(id: number) {
    return api.delete<{ success: boolean }>(`/api/admin/testlab/benchmark/${id}`);
  },

  createExperiment(body: {
    stage: string;
    label?: string;
    promptOverride?: string | null;
    params?: Record<string, unknown>;
    targets?: { storyId: string; pageNumber: number }[];
    benchmarkIds?: number[];
  }) {
    return api.post<{ id: number }>('/api/admin/testlab/experiments', body);
  },

  getExperiments() {
    return api.get<{ experiments: ExperimentSummary[] }>('/api/admin/testlab/experiments');
  },

  getExperiment(id: number) {
    return api.get<ExperimentDetail>(`/api/admin/testlab/experiments/${id}`);
  },

  redo(experimentId: number, resultIndex: number, promptOverride?: string | null) {
    return api.post<{ started: boolean }>(
      `/api/admin/testlab/experiments/${experimentId}/redo`,
      { resultIndex, promptOverride: promptOverride || undefined }
    );
  },

  getTestImage(storyId: string, imageType: string, pageNumber: number | null, versionIndex: number) {
    return api.get<{ imageData: string; isTest: boolean }>(
      `/api/admin/testlab/test-image/${encodeURIComponent(storyId)}/${imageType}/${pageNumber ?? 'null'}/${versionIndex}`
    );
  },

  getBaselineImage(storyId: string, pageNumber: number) {
    return api.get<{ imageData: string }>(
      `/api/admin/testlab/baseline-image/${encodeURIComponent(storyId)}/${pageNumber}`
    );
  },

  promote(storyId: string, pageNumber: number, versionIndex: number, setActive = true) {
    return api.post<{ success: boolean }>('/api/admin/testlab/promote', { storyId, pageNumber, versionIndex, setActive });
  },
};
