/**
 * MIT License
 * Copyright (c) 2026 OpenMuse contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * Ported from OpenMuse apps/server/src/actions.ts (propose/decide with
 * hash + expiry + claim) into Umbra OS backend.
 *
 * Minimal viable gate: propose() hashes the exact input (tamper-evident),
 * sets a 30-minute expiry, decide() re-checks hash/expiry/connection and
 * atomically claims awaiting_review -> executing/denied before running the
 * executor. Used by meeting/execute and desktop2/action consent checks.
 */

import { createHash, randomUUID } from 'node:crypto';

export type ApprovalStatus =
  | 'awaiting_review'
  | 'executing'
  | 'denied'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'outcome_unknown';

export type ApprovalDecision = 'approve' | 'deny';

export interface ActionProposal {
  id: string;
  owner: string;
  title: string;
  kind: string;
  data: Record<string, unknown>;
  status: ApprovalStatus;
  hash: string;
  createdAt: string;
  expiresAt: string;
  taskId?: string;
  connectionId?: string;
  account?: string;
  targetVersion?: string;
  result?: string;
  error?: string;
}

export interface ProposeOptions {
  idempotencyKey?: string;
  taskId?: string;
  connectionId?: string;
  account?: string;
  targetVersion?: string;
  title?: string;
}

export class ApprovalError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = 'ApprovalError';
    this.status = status;
  }
}

const EXPIRY_MS = 30 * 60 * 1000;

function proposalHash(input: { kind: string; data: Record<string, unknown>; connectionId?: string; account?: string; targetVersion?: string }): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function proposalTitle(kind: string, data: Record<string, unknown>): string {
  const title = typeof data.title === 'string' && data.title ? data.title : kind;
  if (kind === 'email.send') return `Send "${String((data as { subject?: unknown }).subject ?? title)}"`;
  if (kind === 'calendar.delete') return `Delete ${title}`;
  if (kind === 'calendar.create') return `Create ${title}`;
  if (kind === 'calendar.update') return `Update ${title}`;
  return `${kind}: ${String(title).slice(0, 120)}`;
}

export class ApprovalGate {
  private proposals = new Map<string, ActionProposal>();
  private now: () => number;

  constructor(now?: () => number) {
    this.now = now ?? Date.now;
  }

  private key(owner: string, id: string): string {
    return `${owner}\n${id}`;
  }

  async propose(
    owner: string,
    kind: string,
    data: Record<string, unknown>,
    opts: ProposeOptions = {},
  ): Promise<ActionProposal> {
    if (!kind || typeof kind !== 'string' || kind.length > 120) {
      throw new ApprovalError('Invalid action kind', 422);
    }
    const id =
      opts.idempotencyKey === undefined
        ? randomUUID()
        : createHash('sha256').update(opts.idempotencyKey).digest('hex');
    const existing = this.proposals.get(this.key(owner, id));
    if (existing) return existing;
    const now = this.now();
    const proposal: ActionProposal = {
      id,
      owner,
      title: opts.title ?? proposalTitle(kind, data),
      kind,
      data,
      connectionId: opts.connectionId,
      account: opts.account,
      targetVersion: opts.targetVersion,
      taskId: opts.taskId,
      status: 'awaiting_review',
      hash: proposalHash({ kind, data, connectionId: opts.connectionId, account: opts.account, targetVersion: opts.targetVersion }),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + EXPIRY_MS).toISOString(),
    };
    this.proposals.set(this.key(owner, id), proposal);
    return proposal;
  }

  get(owner: string, id: string): ActionProposal | undefined {
    return this.proposals.get(this.key(owner, id));
  }

  listPending(owner: string): ActionProposal[] {
    return [...this.proposals.values()].filter((p) => p.owner === owner && p.status === 'awaiting_review');
  }

  /**
   * Validate hash + expiry + single-claim, then run the executor.
   * Returns the finished proposal (succeeded/failed/outcome_unknown/denied).
   */
  async decide(
    owner: string,
    id: string,
    hash: string,
    decision: ApprovalDecision,
    executor?: (proposal: ActionProposal) => Promise<string>,
  ): Promise<ActionProposal> {
    const proposal = this.proposals.get(this.key(owner, id));
    if (!proposal) throw new ApprovalError('Action not found', 404);
    if (proposal.hash !== hash) {
      throw new ApprovalError('This proposal changed. Open its latest review before deciding.', 409);
    }
    if (proposal.status !== 'awaiting_review') return proposal;
    if (Date.parse(proposal.expiresAt) <= this.now()) {
      proposal.status = 'expired';
      throw new ApprovalError('This review expired. Create a fresh proposal.', 409);
    }
    // Atomic claim: only the first decider leaves awaiting_review.
    proposal.status = decision === 'deny' ? 'denied' : 'executing';
    if (decision === 'deny') return proposal;
    try {
      const result = executor ? await executor(proposal) : 'approved';
      proposal.status = 'succeeded';
      proposal.result = result;
    } catch (error) {
      const unknown =
        error instanceof Error &&
        (('outcomeUnknown' in error && (error as { outcomeUnknown?: unknown }).outcomeUnknown === true) ||
          ('code' in error && (error as { code?: unknown }).code === 'outcome_unknown'));
      proposal.status = unknown ? 'outcome_unknown' : 'failed';
      proposal.error = error instanceof Error ? error.message : 'Execution failed';
    }
    return proposal;
  }

  /**
   * Consent-check helper: validate id+hash and claim awaiting_review ->
   * executing so the caller can run the gated action exactly once.
   */
  async consume(owner: string, id: string, hash: string): Promise<ActionProposal> {
    const proposal = this.proposals.get(this.key(owner, id));
    if (!proposal) throw new ApprovalError('Approval not found — propose the action first', 404);
    if (proposal.hash !== hash) throw new ApprovalError('Approval hash mismatch — re-propose', 409);
    if (proposal.status !== 'awaiting_review') {
      throw new ApprovalError(`Approval is ${proposal.status} — create a fresh proposal`, 409);
    }
    if (Date.parse(proposal.expiresAt) <= this.now()) {
      proposal.status = 'expired';
      throw new ApprovalError('Approval expired — create a fresh proposal', 409);
    }
    proposal.status = 'executing';
    return proposal;
  }

  async complete(owner: string, id: string, ok: boolean, detail?: string): Promise<ActionProposal | undefined> {
    const proposal = this.proposals.get(this.key(owner, id));
    if (!proposal) return undefined;
    if (proposal.status === 'executing') {
      proposal.status = ok ? 'succeeded' : 'failed';
      if (ok) proposal.result = detail ?? proposal.result;
      else proposal.error = detail ?? proposal.error;
    }
    return proposal;
  }
}
