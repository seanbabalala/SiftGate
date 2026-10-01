import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { coordinatedRepositoryOperation } from '../database/coordinated-repository';
import type {
  CanonicalMessage,
  CanonicalRequest,
} from '../canonical/canonical.types';
import { ConfigService } from '../config/config.service';
import {
  CallLog,
  EvalDataset,
  EvalExperimentRun,
  EvalSampleResult,
} from '../database/entities';
import type { PipelineResult } from '../pipeline/pipeline.service';
import { PipelineService } from '../pipeline/pipeline.service';
import { WorkspaceContextService } from '../workspaces/workspace-context.service';
import {
  applyWorkspaceQueryScope,
  normalizeWorkspaceId,
  workspaceFindWhere,
} from '../workspaces/workspace-scope';

export interface EvalRecordedRunInput {
  dataset: EvalDatasetInput;
  primary: EvalTargetInput;
  candidate: EvalTargetInput;
  judge?: EvalJudgeConfigInput;
  samples: Array<{
    sample_id?: string | null;
    sample_hash: string;
    primary: Partial<EvalTargetMetrics>;
    candidate: Partial<EvalTargetMetrics>;
    judge?: Partial<EvalJudgeResult>;
    metadata?: Record<string, unknown>;
  }>;
  status?: 'completed' | 'failed';
  error?: string | null;
}

export interface EvalTargetInput {
  node_id?: string | null;
  model: string;
}

export interface EvalJudgeConfigInput {
  model?: string;
  node_id?: string | null;
  rubric?: string;
  score_scale?: 'zero_to_one' | 'one_to_five' | 'zero_to_ten';
}

export interface EvalDatasetInput {
  id?: string | null;
  name: string;
  description?: string | null;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface EvalSampleInput {
  id?: string;
  prompt?: string;
  expected?: string;
  canonical?: CanonicalRequest;
  metadata?: Record<string, unknown>;
}

export interface EvalRunComparisonInput {
  dataset: EvalDatasetInput;
  primary: EvalTargetInput;
  candidate: EvalTargetInput;
  judge?: EvalJudgeConfigInput;
  samples: EvalSampleInput[];
  store_samples?: boolean;
}

export interface EvalReportFilters {
  period?: string;
  status?: string;
  dataset_id?: string;
  limit?: number;
}

interface EvalTargetMetrics {
  request_id: string | null;
  status_code: number | null;
  success: boolean;
  latency_ms: number;
  cost_usd: number;
  is_fallback: boolean;
  output_text: string;
  error_type: string | null;
}

interface EvalJudgeResult {
  request_id: string | null;
  score: number | null;
  label: string | null;
  reason_summary: string | null;
}

const DEFAULT_JUDGE_RUBRIC =
  'Compare the candidate answer against the primary answer and expected outcome. Score candidate quality from 0 to 1.';

@Injectable()
export class EvaluationService {
  private databaseScoped = false;
  private readonly logger = new Logger(EvaluationService.name);

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(EvalDataset)
    private readonly datasets: Repository<EvalDataset>,
    @InjectRepository(EvalExperimentRun)
    private readonly runs: Repository<EvalExperimentRun>,
    @InjectRepository(EvalSampleResult)
    private readonly samples: Repository<EvalSampleResult>,
    @InjectRepository(CallLog)
    private readonly callLogs: Repository<CallLog>,
    private readonly workspaceContext: WorkspaceContextService,
    @Optional()
    private readonly pipeline?: PipelineService,
  ) {}

  /** Only repository work belongs here; target and judge calls stay outside. */
  private database<T>(
    write: boolean,
    action: (service: EvaluationService) => Promise<T>,
  ): Promise<T> {
    if (this.databaseScoped) return action(this);
    return coordinatedRepositoryOperation(this.runs, write, (manager) => {
      if (!manager) return action(this);
      const scoped = new EvaluationService(
        this.config,
        manager.getRepository(EvalDataset),
        manager.getRepository(EvalExperimentRun),
        manager.getRepository(EvalSampleResult),
        manager.getRepository(CallLog),
        this.workspaceContext,
        this.pipeline,
      );
      scoped.databaseScoped = true;
      return action(scoped);
    });
  }

  listReports(filters: EvalReportFilters = {}) {
    return this.database(false, (service) =>
      service.listReportsInDatabase(filters),
    );
  }

  private async listReportsInDatabase(filters: EvalReportFilters) {
    const period = filters.period || '30d';
    const limit = this.clamp(filters.limit, 50, 500);
    const qb = this.runs.createQueryBuilder('run').where('1 = 1');
    applyWorkspaceQueryScope(qb, 'run', this.workspaceId());
    const since = this.periodStart(period);
    if (since) qb.andWhere('run.created_at >= :since', { since });
    if (filters.status)
      qb.andWhere('run.status = :status', { status: filters.status });
    if (filters.dataset_id)
      qb.andWhere('run.dataset_id = :datasetId', {
        datasetId: filters.dataset_id,
      });

    const rows = await qb
      .orderBy('run.created_at', 'DESC')
      .take(limit)
      .getMany();
    return {
      generated_at: new Date().toISOString(),
      metadata_only: true,
      filters: {
        period,
        status: filters.status || null,
        dataset_id: filters.dataset_id || null,
      },
      totals: this.totals(rows),
      items: rows.map((run) => this.toRunSummary(run)),
      privacy: this.privacySummary(false),
    };
  }

  getReport(id: string) {
    return this.database(false, (service) => service.getReportInDatabase(id));
  }

  private async getReportInDatabase(id: string) {
    const run = await this.runs.findOne({
      where: workspaceFindWhere(this.workspaceId(), { id }),
    });
    if (!run) return null;
    const rows = await this.samples.find({
      where: workspaceFindWhere(this.workspaceId(), { run_id: id }),
      order: { id: 'ASC' },
      take: 500,
    });
    return {
      generated_at: new Date().toISOString(),
      metadata_only: true,
      run: this.toRunDetail(run),
      samples: rows.map((sample) => this.toSampleSummary(sample)),
      privacy: this.privacySummary(
        this.safeJson(run.privacy_json)?.sample_previews_stored === true,
      ),
    };
  }

  recordRun(input: EvalRecordedRunInput) {
    return this.database(true, (service) => service.recordRunInDatabase(input));
  }

  private async recordRunInDatabase(input: EvalRecordedRunInput) {
    const dataset = await this.upsertDatasetMetadata(
      input.dataset,
      input.samples.length,
      false,
    );
    const now = new Date().toISOString();
    const workspaceId = this.workspaceId();
    const run = this.runs.create({
      workspace_id: workspaceId,
      dataset_id: dataset.id,
      dataset_name: dataset.name,
      primary_node_id: input.primary.node_id || null,
      primary_model: input.primary.model,
      candidate_node_id: input.candidate.node_id || null,
      candidate_model: input.candidate.model,
      judge_node_id: input.judge?.node_id || null,
      judge_model: input.judge?.model || null,
      judge_config_json: this.stringifySafe({
        model: input.judge?.model || null,
        node_id: input.judge?.node_id || null,
        score_scale: input.judge?.score_scale || 'zero_to_one',
        rubric_hash: input.judge?.rubric ? this.hash(input.judge.rubric) : null,
      }),
      status: input.status || 'completed',
      sample_count: input.samples.length,
      started_at: now,
      completed_at: now,
      error: input.error || null,
      privacy_json: this.stringifySafe(this.privacySummary(false)),
    });
    this.applyAggregateMetrics(
      run,
      input.samples.map((sample) => ({
        primary: this.metricDefaults(sample.primary),
        candidate: this.metricDefaults(sample.candidate),
        judge: {
          request_id: sample.judge?.request_id || null,
          score:
            typeof sample.judge?.score === 'number' ? sample.judge.score : null,
          label: sample.judge?.label || null,
          reason_summary: sample.judge?.reason_summary || null,
        },
      })),
    );
    const saved = await this.runs.save(run);
    await this.samples.save(
      input.samples.map((sample) =>
        this.samples.create({
          workspace_id: workspaceId,
          run_id: saved.id,
          sample_id: sample.sample_id || null,
          sample_hash: sample.sample_hash,
          primary_request_id: sample.primary.request_id || null,
          candidate_request_id: sample.candidate.request_id || null,
          judge_request_id: sample.judge?.request_id || null,
          primary_status_code: sample.primary.status_code ?? null,
          candidate_status_code: sample.candidate.status_code ?? null,
          primary_success: Boolean(sample.primary.success),
          candidate_success: Boolean(sample.candidate.success),
          primary_latency_ms: Math.max(
            0,
            Number(sample.primary.latency_ms || 0),
          ),
          candidate_latency_ms: Math.max(
            0,
            Number(sample.candidate.latency_ms || 0),
          ),
          primary_cost_usd: Math.max(0, Number(sample.primary.cost_usd || 0)),
          candidate_cost_usd: Math.max(
            0,
            Number(sample.candidate.cost_usd || 0),
          ),
          primary_fallback: Boolean(sample.primary.is_fallback),
          candidate_fallback: Boolean(sample.candidate.is_fallback),
          judge_score:
            typeof sample.judge?.score === 'number' ? sample.judge.score : null,
          judge_label: sample.judge?.label || null,
          judge_reason_summary: this.summarizeReason(
            sample.judge?.reason_summary,
          ),
          error_type: this.firstErrorType(
            sample.primary.error_type,
            sample.candidate.error_type,
          ),
          metadata_json: this.stringifySafe(
            this.sanitizeMetadata(sample.metadata || {}),
          ),
        }),
      ),
    );
    return this.getReport(saved.id);
  }

  async runComparison(input: EvalRunComparisonInput) {
    if (!this.pipeline) {
      throw new BadRequestException(
        'Evaluation runner requires PipelineService.',
      );
    }
    if (!Array.isArray(input.samples) || input.samples.length === 0) {
      throw new BadRequestException(
        'Evaluation run requires at least one sample.',
      );
    }

    const sampleStorageEnabled = this.sampleStorageEnabled(input);
    const dataset = await this.upsertDatasetMetadata(
      input.dataset,
      input.samples.length,
      sampleStorageEnabled,
    );
    const workspaceId = this.workspaceId();
    const run = await this.database(true, (service) =>
      service.runs.save(
        service.runs.create({
          workspace_id: workspaceId,
          dataset_id: dataset.id,
          dataset_name: dataset.name,
          primary_node_id: input.primary.node_id || null,
          primary_model: input.primary.model,
          candidate_node_id: input.candidate.node_id || null,
          candidate_model: input.candidate.model,
          judge_node_id: input.judge?.node_id || null,
          judge_model: input.judge?.model || 'auto',
          judge_config_json: this.stringifySafe(
            this.safeJudgeConfig(input.judge),
          ),
          status: 'running',
          sample_count: input.samples.length,
          started_at: new Date().toISOString(),
          completed_at: null,
          privacy_json: this.stringifySafe(
            this.privacySummary(sampleStorageEnabled),
          ),
        }),
      ),
    );

    const results: Array<{
      primary: EvalTargetMetrics;
      candidate: EvalTargetMetrics;
      judge: EvalJudgeResult;
    }> = [];

    try {
      for (const [index, sample] of input.samples.entries()) {
        const sampleHash = this.sampleHash(sample);
        const primary = await this.executeTarget(
          run.id,
          sample,
          input.primary,
          'primary',
          index,
        );
        const candidate = await this.executeTarget(
          run.id,
          sample,
          input.candidate,
          'candidate',
          index,
        );
        const judge = await this.executeJudge(
          run.id,
          sample,
          input.judge,
          primary.output_text,
          candidate.output_text,
          index,
        );
        results.push({ primary, candidate, judge });
        await this.database(true, (service) =>
          service.samples.save(
            service.samples.create({
              workspace_id: workspaceId,
              run_id: run.id,
              sample_id: sample.id || null,
              sample_hash: sampleHash,
              primary_request_id: primary.request_id,
              candidate_request_id: candidate.request_id,
              judge_request_id: judge.request_id,
              primary_status_code: primary.status_code,
              candidate_status_code: candidate.status_code,
              primary_success: primary.success,
              candidate_success: candidate.success,
              primary_latency_ms: primary.latency_ms,
              candidate_latency_ms: candidate.latency_ms,
              primary_cost_usd: primary.cost_usd,
              candidate_cost_usd: candidate.cost_usd,
              primary_fallback: primary.is_fallback,
              candidate_fallback: candidate.is_fallback,
              judge_score: judge.score,
              judge_label: judge.label,
              judge_reason_summary: this.summarizeReason(judge.reason_summary),
              error_type: this.firstErrorType(
                primary.error_type,
                candidate.error_type,
              ),
              metadata_json: this.stringifySafe({
                ...this.sanitizeMetadata(sample.metadata || {}),
                sample_previews_stored: sampleStorageEnabled,
                ...(sampleStorageEnabled
                  ? {
                      prompt_preview: this.redactAndTrim(
                        sample.prompt ||
                          this.canonicalPromptText(sample.canonical),
                      ),
                      expected_preview: this.redactAndTrim(
                        sample.expected || '',
                      ),
                      primary_preview: this.redactAndTrim(primary.output_text),
                      candidate_preview: this.redactAndTrim(
                        candidate.output_text,
                      ),
                    }
                  : {}),
              }),
            }),
          ),
        );
      }
      this.applyAggregateMetrics(run, results);
      run.status = 'completed';
      run.completed_at = new Date().toISOString();
      await this.database(true, (service) => service.runs.save(run));
    } catch (error) {
      run.status = 'failed';
      run.error = this.redactAndTrim(
        error instanceof Error ? error.message : String(error),
        500,
      );
      run.completed_at = new Date().toISOString();
      await this.database(true, (service) => service.runs.save(run));
      throw error;
    }

    return this.getReport(run.id);
  }

  private async executeTarget(
    runId: string,
    sample: EvalSampleInput,
    target: EvalTargetInput,
    role: 'primary' | 'candidate',
    index: number,
  ): Promise<EvalTargetMetrics> {
    const sessionKey = `eval-${runId}-${index}-${role}-${randomUUID()}`;
    const canonical = this.buildTargetCanonical(sample, target, sessionKey);
    const started = Date.now();
    try {
      const result = await this.pipeline!.process(canonical);
      const log = await this.findLogBySession(sessionKey);
      return {
        request_id: log?.request_id || null,
        status_code: log?.status_code ?? result.statusCode,
        success: result.statusCode >= 200 && result.statusCode < 400,
        latency_ms: log?.latency_ms ?? Date.now() - started,
        cost_usd: Number(log?.cost_usd || 0),
        is_fallback: Boolean(log?.is_fallback),
        output_text: this.extractText(result),
        error_type: result.statusCode >= 400 ? this.errorType(result.body) : null,
      };
    } catch (error) {
      const log = await this.findLogBySession(sessionKey);
      return {
        request_id: log?.request_id || null,
        status_code: log?.status_code ?? 500,
        success: false,
        latency_ms: log?.latency_ms ?? Date.now() - started,
        cost_usd: Number(log?.cost_usd || 0),
        is_fallback: Boolean(log?.is_fallback),
        output_text: '',
        error_type: this.redactAndTrim(error instanceof Error ? error.name : String(error), 120),
      };
    }
  }

  private async executeJudge(
    runId: string,
    sample: EvalSampleInput,
    judge: EvalJudgeConfigInput | undefined,
    primaryOutput: string,
    candidateOutput: string,
    index: number,
  ): Promise<EvalJudgeResult> {
    const sessionKey = `eval-${runId}-${index}-judge-${randomUUID()}`;
    const prompt = [
      judge?.rubric || DEFAULT_JUDGE_RUBRIC,
      '',
      `Expected summary hash: ${sample.expected ? this.hash(sample.expected) : 'none'}`,
      `Primary answer:\n${primaryOutput}`,
      '',
      `Candidate answer:\n${candidateOutput}`,
      '',
      'Return compact JSON: {"score":0.0,"label":"primary|candidate|tie","reason":"short metadata-only reason"}.',
    ].join('\n');
    const canonical = this.buildTextCanonical(prompt, judge?.model || 'auto', sessionKey);
    const result = await this.pipeline!.process(canonical);
    const log = await this.findLogBySession(sessionKey);
    const parsed = this.parseJudgeResult(this.extractText(result));
    return {
      request_id: log?.request_id || null,
      score: parsed.score,
      label: parsed.label,
      reason_summary: parsed.reason,
    };
  }

  private buildTargetCanonical(
    sample: EvalSampleInput,
    target: EvalTargetInput,
    sessionKey: string,
  ): CanonicalRequest {
    if (sample.canonical) {
      const cloned = JSON.parse(JSON.stringify(sample.canonical)) as CanonicalRequest;
      cloned.metadata = {
        ...cloned.metadata,
        original_model: target.model,
        session_key: sessionKey,
        session_id: sessionKey,
        trace_id: `eval-${sessionKey}`,
        raw_headers: {},
        workspace_id: this.workspaceId(),
      };
      return cloned;
    }
    return this.buildTextCanonical(sample.prompt || '', target.model, sessionKey);
  }

  private buildTextCanonical(prompt: string, model: string, sessionKey: string): CanonicalRequest {
    const messages: CanonicalMessage[] = [{ role: 'user', content: prompt }];
    return {
      messages,
      model,
      temperature: 0,
      stream: false,
      metadata: {
        source_format: 'chat_completions',
        original_model: model,
        session_key: sessionKey,
        session_id: sessionKey,
        trace_id: `eval-${sessionKey}`,
        raw_headers: {},
        workspace_id: this.workspaceId(),
      },
    } as CanonicalRequest & { model: string };
  }

  private async findLogBySession(sessionKey: string): Promise<CallLog | null> {
    if (!this.databaseScoped && this.runs.manager?.connection)
      return this.database(false, (service) =>
        service.findLogBySession(sessionKey),
      );
    return this.callLogs.findOne({
      where: workspaceFindWhere(this.workspaceId(), {
        session_key: sessionKey,
      }),
    });
  }

  private async upsertDatasetMetadata(
    input: EvalDatasetInput,
    sampleCount: number,
    sampleStorageEnabled: boolean,
  ): Promise<EvalDataset> {
    if (!this.databaseScoped && this.runs.manager?.connection)
      return this.database(true, (service) =>
        service.upsertDatasetMetadata(input, sampleCount, sampleStorageEnabled),
      );
    const name = this.requiredString(input.name, 'dataset.name');
    const existing = input.id
      ? await this.datasets.findOne({
          where: workspaceFindWhere(this.workspaceId(), { id: input.id }),
        })
      : null;
    const entity = existing || this.datasets.create();
    entity.workspace_id = this.workspaceId();
    entity.name = name;
    entity.description = this.nullableString(input.description);
    entity.source = this.nullableString(input.source) || 'local';
    entity.sample_count = sampleCount;
    entity.sample_storage_enabled = sampleStorageEnabled;
    entity.metadata_json = this.stringifySafe(
      this.sanitizeMetadata(input.metadata || {}),
    );
    return this.datasets.save(entity);
  }

  private workspaceId(): string {
    return normalizeWorkspaceId(this.workspaceContext.currentWorkspaceId());
  }

  private applyAggregateMetrics(
    run: EvalExperimentRun,
    results: Array<{
      primary: EvalTargetMetrics;
      candidate: EvalTargetMetrics;
      judge: EvalJudgeResult;
    }>,
  ): void {
    const count = Math.max(results.length, 1);
    const primarySuccess = results.filter((item) => item.primary.success).length;
    const candidateSuccess = results.filter((item) => item.candidate.success).length;
    const primaryFallback = results.filter((item) => item.primary.is_fallback).length;
    const candidateFallback = results.filter((item) => item.candidate.is_fallback).length;
    const judgeScores = results
      .map((item) => item.judge.score)
      .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
    const avgJudge = judgeScores.length > 0
      ? this.round(judgeScores.reduce((sum, score) => sum + score, 0) / judgeScores.length, 4)
      : null;

    run.sample_count = results.length;
    run.primary_success_rate = this.percent(primarySuccess, count);
    run.candidate_success_rate = this.percent(candidateSuccess, count);
    run.primary_avg_latency_ms = this.round(
      results.reduce((sum, item) => sum + item.primary.latency_ms, 0) / count,
      2,
    );
    run.candidate_avg_latency_ms = this.round(
      results.reduce((sum, item) => sum + item.candidate.latency_ms, 0) / count,
      2,
    );
    run.primary_total_cost_usd = this.round(results.reduce((sum, item) => sum + item.primary.cost_usd, 0), 6);
    run.candidate_total_cost_usd = this.round(results.reduce((sum, item) => sum + item.candidate.cost_usd, 0), 6);
    run.primary_fallback_rate = this.percent(primaryFallback, count);
    run.candidate_fallback_rate = this.percent(candidateFallback, count);
    run.avg_judge_score = avgJudge;
    run.winner = this.pickWinner(run, avgJudge);
    run.summary_json = this.stringifySafe({
      success_delta: this.round(run.candidate_success_rate - run.primary_success_rate, 2),
      latency_delta_ms: this.round(run.candidate_avg_latency_ms - run.primary_avg_latency_ms, 2),
      cost_delta_usd: this.round(run.candidate_total_cost_usd - run.primary_total_cost_usd, 6),
      fallback_delta: this.round(run.candidate_fallback_rate - run.primary_fallback_rate, 2),
      judge_sample_coverage: this.percent(judgeScores.length, count),
    });
  }

  private pickWinner(run: EvalExperimentRun, avgJudge: number | null): 'primary' | 'candidate' | 'tie' {
    if (avgJudge !== null) {
      if (avgJudge > 0.55) return 'candidate';
      if (avgJudge < 0.45) return 'primary';
      return 'tie';
    }
    const successDelta = run.candidate_success_rate - run.primary_success_rate;
    const costDelta = run.candidate_total_cost_usd - run.primary_total_cost_usd;
    if (successDelta > 2) return 'candidate';
    if (successDelta < -2) return 'primary';
    if (costDelta < -0.000001) return 'candidate';
    if (costDelta > 0.000001) return 'primary';
    return 'tie';
  }

  private toRunSummary(run: EvalExperimentRun) {
    return {
      id: run.id,
      dataset_id: run.dataset_id,
      dataset_name: run.dataset_name,
      status: run.status,
      sample_count: run.sample_count,
      primary: {
        node_id: run.primary_node_id,
        model: run.primary_model,
        success_rate: run.primary_success_rate,
        avg_latency_ms: run.primary_avg_latency_ms,
        total_cost_usd: run.primary_total_cost_usd,
        fallback_rate: run.primary_fallback_rate,
      },
      candidate: {
        node_id: run.candidate_node_id,
        model: run.candidate_model,
        success_rate: run.candidate_success_rate,
        avg_latency_ms: run.candidate_avg_latency_ms,
        total_cost_usd: run.candidate_total_cost_usd,
        fallback_rate: run.candidate_fallback_rate,
      },
      judge: {
        node_id: run.judge_node_id,
        model: run.judge_model,
        avg_score: run.avg_judge_score,
      },
      winner: run.winner,
      summary: this.safeJson(run.summary_json) || {},
      privacy: this.safeJson(run.privacy_json) || this.privacySummary(false),
      error: run.error,
      started_at: run.started_at,
      completed_at: run.completed_at,
      created_at: run.created_at,
      updated_at: run.updated_at,
    };
  }

  private toRunDetail(run: EvalExperimentRun) {
    return {
      ...this.toRunSummary(run),
      judge_config: this.safeJson(run.judge_config_json) || {},
    };
  }

  private toSampleSummary(sample: EvalSampleResult) {
    return {
      id: sample.id,
      sample_id: sample.sample_id,
      sample_hash: sample.sample_hash,
      request_ids: {
        primary: sample.primary_request_id,
        candidate: sample.candidate_request_id,
        judge: sample.judge_request_id,
      },
      primary: {
        status_code: sample.primary_status_code,
        success: sample.primary_success,
        latency_ms: sample.primary_latency_ms,
        cost_usd: sample.primary_cost_usd,
        fallback: sample.primary_fallback,
      },
      candidate: {
        status_code: sample.candidate_status_code,
        success: sample.candidate_success,
        latency_ms: sample.candidate_latency_ms,
        cost_usd: sample.candidate_cost_usd,
        fallback: sample.candidate_fallback,
      },
      judge: {
        score: sample.judge_score,
        label: sample.judge_label,
        reason_summary: sample.judge_reason_summary,
      },
      error_type: sample.error_type,
      metadata: this.safeJson(sample.metadata_json) || {},
      created_at: sample.created_at,
    };
  }

  private totals(rows: EvalExperimentRun[]) {
    return {
      runs: rows.length,
      completed: rows.filter((run) => run.status === 'completed').length,
      failed: rows.filter((run) => run.status === 'failed').length,
      samples: rows.reduce((sum, run) => sum + (run.sample_count || 0), 0),
      avg_judge_score: this.avg(rows.map((run) => run.avg_judge_score)),
    };
  }

  private privacySummary(samplePreviewsStored: boolean) {
    return {
      prompt_response_stored: samplePreviewsStored,
      sample_previews_stored: samplePreviewsStored,
      raw_headers_stored: false,
      provider_keys_exposed: false,
      metadata_only: !samplePreviewsStored,
      requires_explicit_sample_storage: true,
    };
  }

  private safeJudgeConfig(judge: EvalJudgeConfigInput | undefined) {
    return {
      model: judge?.model || 'auto',
      node_id: judge?.node_id || null,
      score_scale: judge?.score_scale || 'zero_to_one',
      rubric_hash: judge?.rubric ? this.hash(judge.rubric) : this.hash(DEFAULT_JUDGE_RUBRIC),
    };
  }

  private sampleStorageEnabled(input: EvalRunComparisonInput): boolean {
    const cfg = this.config.getFullConfig().evaluation;
    return Boolean(cfg?.store_samples === true && input.store_samples === true);
  }

  private sampleHash(sample: EvalSampleInput): string {
    return this.hash(JSON.stringify({
      id: sample.id || null,
      prompt: sample.prompt || null,
      expected: sample.expected || null,
      canonical: sample.canonical ? this.canonicalPromptText(sample.canonical) : null,
      metadata: this.sanitizeMetadata(sample.metadata || {}),
    }));
  }

  private canonicalPromptText(canonical: CanonicalRequest | undefined): string {
    if (!canonical) return '';
    return (canonical.messages || [])
      .map((message) => typeof message.content === 'string'
        ? message.content
        : message.content?.map((block) => block.type === 'text' ? block.text : `[${block.type}]`).join(' '))
      .join('\n');
  }

  private extractText(result: PipelineResult): string {
    const body = result.body;
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body)) return '[binary response]';
    if (!body || typeof body !== 'object') return '';
    const record = body as Record<string, unknown>;
    if (typeof record.output_text === 'string') return record.output_text;
    if (typeof record.completion === 'string') return record.completion;
    if (Array.isArray(record.choices)) {
      const choice = record.choices[0] as Record<string, unknown> | undefined;
      const message = choice?.message as Record<string, unknown> | undefined;
      if (typeof message?.content === 'string') return message.content;
      if (typeof choice?.text === 'string') return choice.text;
    }
    if (Array.isArray(record.content)) {
      return record.content
        .map((item) => typeof item === 'string'
          ? item
          : typeof item === 'object' && item && 'text' in item
            ? String((item as { text?: unknown }).text || '')
            : '')
        .filter(Boolean)
        .join('\n');
    }
    if (Array.isArray(record.output)) {
      return record.output
        .map((item) => JSON.stringify(item))
        .join('\n');
    }
    return JSON.stringify(record).slice(0, 20_000);
  }

  private parseJudgeResult(text: string): { score: number | null; label: string | null; reason: string | null } {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        return {
          score: this.normalizeScore(parsed.score),
          label: typeof parsed.label === 'string' ? parsed.label : null,
          reason: this.summarizeReason(typeof parsed.reason === 'string' ? parsed.reason : null),
        };
      } catch {
        // fall through to numeric extraction
      }
    }
    const numeric = text.match(/(?:score|rating)?\s*[:=]?\s*(0(?:\.\d+)?|1(?:\.0+)?|\d+(?:\.\d+)?)/i);
    return {
      score: numeric ? this.normalizeScore(Number(numeric[1])) : null,
      label: null,
      reason: this.summarizeReason(text),
    };
  }

  private normalizeScore(value: unknown): number | null {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return null;
    if (numeric > 1) return this.round(Math.min(10, Math.max(0, numeric)) / 10, 4);
    return this.round(Math.min(1, Math.max(0, numeric)), 4);
  }

  private metricDefaults(input: Partial<EvalTargetMetrics>): EvalTargetMetrics {
    return {
      request_id: input.request_id || null,
      status_code: input.status_code ?? null,
      success: Boolean(input.success),
      latency_ms: Math.max(0, Number(input.latency_ms || 0)),
      cost_usd: Math.max(0, Number(input.cost_usd || 0)),
      is_fallback: Boolean(input.is_fallback),
      output_text: '',
      error_type: input.error_type || null,
    };
  }

  private sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata).slice(0, 50)) {
      if (/prompt|response|content|authorization|api[_-]?key|token|secret/i.test(key)) {
        sanitized[key] = '[redacted]';
      } else if (typeof value === 'string') {
        sanitized[key] = this.redactAndTrim(value, 240);
      } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
        sanitized[key] = value;
      } else {
        sanitized[key] = '[metadata]';
      }
    }
    return sanitized;
  }

  private redactAndTrim(value: string, max = this.config.getFullConfig().evaluation?.max_sample_chars || 500): string {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(/sk-[A-Za-z0-9]{12,}/g, 'sk-[redacted]')
      .replace(/gw_sk_[A-Za-z0-9_=-]{12,}/g, 'gw_sk_[redacted]')
      .slice(0, Math.max(0, max));
  }

  private summarizeReason(value: string | null | undefined): string | null {
    if (!value) return null;
    return this.redactAndTrim(value.replace(/\s+/g, ' ').trim(), 280);
  }

  private firstErrorType(...values: Array<string | null | undefined>): string | null {
    return values.find((value) => value && value.trim()) || null;
  }

  private errorType(body: unknown): string {
    if (typeof body === 'string') return this.redactAndTrim(body, 120);
    if (body && typeof body === 'object') {
      const error = (body as Record<string, unknown>).error;
      if (error && typeof error === 'object') {
        const message = (error as Record<string, unknown>).message;
        return this.redactAndTrim(typeof message === 'string' ? message : JSON.stringify(error), 120);
      }
      return this.redactAndTrim(JSON.stringify(body), 120);
    }
    return 'upstream_error';
  }

  private stringifySafe(value: unknown): string {
    return JSON.stringify(value ?? {});
  }

  private safeJson(value: string | null | undefined): Record<string, unknown> | null {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  private requiredString(value: unknown, path: string): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) throw new BadRequestException(`${path} is required.`);
    return normalized;
  }

  private nullableString(value: unknown): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized || null;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private periodStart(period: string): Date | null {
    if (period === 'all') return null;
    const ms: Record<string, number> = {
      '1h': 60 * 60_000,
      '24h': 24 * 60 * 60_000,
      '7d': 7 * 24 * 60 * 60_000,
      '30d': 30 * 24 * 60 * 60_000,
      '90d': 90 * 24 * 60 * 60_000,
    };
    return new Date(Date.now() - (ms[period] || ms['30d']));
  }

  private avg(values: Array<number | null>): number | null {
    const filtered = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return filtered.length ? this.round(filtered.reduce((sum, value) => sum + value, 0) / filtered.length, 4) : null;
  }

  private percent(count: number, total: number): number {
    return total > 0 ? this.round((count / total) * 100, 2) : 0;
  }

  private round(value: number, digits = 2): number {
    const scale = 10 ** digits;
    return Math.round((Number.isFinite(value) ? value : 0) * scale) / scale;
  }

  private clamp(value: number | undefined, fallback: number, max: number): number {
    const numeric = Number(value || fallback);
    return Math.min(Math.max(Number.isFinite(numeric) ? numeric : fallback, 1), max);
  }
}
