'use client';

import React, { useState } from 'react';
import { Modal, Field, Icon, fmtDate } from '@/components/legacy/ui';
import { AppUser } from '@/lib/types';

interface TransitionRecord {
  id: string;
  from_stage: string | null;
  to_stage: string;
  action: string;
  acted_by_name?: string;
  acted_as_group?: string;
  acted_at: string;
  note?: string;
}

export interface WorkflowStageDef {
  key: string;
  label: string;
  group: string;
}

interface WorkflowStepperProps {
  caseId: string;
  caseCode: string;
  currentStage: string;
  transitions: TransitionRecord[];
  currentUser: AppUser | null;
  onAdvanced: (newStage: string) => void;
  stages?: WorkflowStageDef[];
}

export const WORKFLOW_STAGES: WorkflowStageDef[] = [
  { key: 'Prepared', label: 'Field Initiation', group: 'Land Officer' },
  { key: 'Checked', label: 'Negotiation Check', group: 'Negotiation Group' },
  { key: 'Reviewed', label: 'Legal Clearance', group: 'Legal Advisor' },
  { key: 'Verified', label: 'Field Admin Endorsement', group: 'Sr. Administrator LMS (Field)' },
  { key: 'Field Approved', label: 'Field Approval (DM/TL)', group: 'DM / Team Lead (Field)' },
  { key: 'HO Approved', label: 'HO Kharat Approval', group: 'Manager Land (HO)' },
];

export default function WorkflowStepper({
  caseId,
  caseCode,
  currentStage,
  transitions,
  currentUser,
  onAdvanced,
  stages = WORKFLOW_STAGES,
}: WorkflowStepperProps) {
  const [advancing, setAdvancing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const currentStageIndex = stages.findIndex((s) => s.key === currentStage);
  const nextStage =
    currentStageIndex >= 0 && currentStageIndex < stages.length - 1 ? stages[currentStageIndex + 1] : null;

  const terminalKey = stages[stages.length - 1]?.key || 'HO Approved';
  const isTerminal = currentStage === terminalKey || currentStage === 'Cancelled' || currentStage === 'Stopped';

  const handleAdvance = async (targetStageKey?: string, targetGroup?: string) => {
    const target = targetStageKey || nextStage?.key;
    if (!target) return;
    setAdvancing(true);
    setErrorMsg(null);

    try {
      const res = await fetch(`/api/cases/${caseId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to_stage: target,
          note: remarks || `Transitioned to ${target}`,
          as_group: targetGroup || nextStage?.group || null,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to advance workflow');
      }

      setModalOpen(false);
      setCancelModalOpen(false);
      setRemarks('');
      onAdvanced(data.new_stage);
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setAdvancing(false);
    }
  };

  const stopped = currentStage === 'Cancelled' || currentStage === 'Stopped';
  return (
    <div className="u-mt-14">
      <div className="card-h">
        <div>
          <h3>Approval workflow</h3>
          <p>{stages.length} steps, each by a designated role · recorded in the audit trail</p>
        </div>
        <div className="acts">
          {!isTerminal && currentStageIndex === 0 && (
            <button
              className="btn btn-d btn-sm"
              onClick={() => {
                setErrorMsg(null);
                setRemarks('');
                setCancelModalOpen(true);
              }}
            >
              Cancel case
            </button>
          )}
          {!isTerminal && nextStage && (
            <button
              className="btn btn-p"
              onClick={() => {
                setErrorMsg(null);
                setRemarks('');
                setModalOpen(true);
              }}
            >
              <Icon name="send" size={14} /> Advance to {nextStage.key}
            </button>
          )}
          {currentStage === terminalKey && (
            <span className="b b-g">
              <Icon name="lock" size={12} />
              &nbsp;Approved and locked
            </span>
          )}
          {stopped && <span className="b b-r">{currentStage}</span>}
        </div>
      </div>

      <div className="wf" aria-label="Workflow stage">
        {stages.map((stage, idx) => {
          const done = currentStageIndex > idx || currentStage === terminalKey;
          const cur = currentStageIndex === idx && currentStage !== terminalKey;
          return (
            <div
              key={stage.key}
              className={`st${stopped && cur ? ' x' : done ? ' done' : cur ? ' cur' : ''}`}
              aria-current={cur ? 'step' : undefined}
              title={`${stage.label} — ${stage.group}`}
            >
              {idx + 1}. {stage.key}
            </div>
          );
        })}
      </div>

      <div className="sec-t">History</div>
      <div className="tl u-mt-8">
        {transitions.length === 0 && (
          <div>
            <small>No decisions recorded yet.</small>
          </div>
        )}
        {transitions.map((t) => (
          <div key={t.id}>
            <b>
              {t.from_stage ? `${t.from_stage} → ` : ''}
              {t.to_stage}
            </b>{' '}
            · {t.acted_by_name || 'System'}
            {t.acted_as_group ? ` (${t.acted_as_group})` : ''}
            <br />
            <small>
              {fmtDate(t.acted_at)}
              {t.note ? ` — “${t.note}”` : ''}
            </small>
          </div>
        ))}
        {!isTerminal && nextStage && (
          <div>
            <small>
              Waiting on {nextStage.group} for “{nextStage.label}”.
            </small>
          </div>
        )}
      </div>

      <Modal
        open={modalOpen && !!nextStage}
        stacked
        size="sm"
        icon="send"
        title={`Advance case to ${nextStage?.key ?? ''}`}
        onClose={() => setModalOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-s" onClick={() => setModalOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-p" onClick={() => handleAdvance()} disabled={advancing}>
              {advancing ? 'Advancing…' : 'Confirm'}
            </button>
          </>
        }
      >
        <p className="u-mb-10">
          Case <span className="code">{caseCode}</span> moves to <b>{nextStage?.key}</b> under the authority of{' '}
          <b>{nextStage?.group}</b>. Signed in as {currentUser?.full_name}
          {currentUser?.position ? ` (${currentUser.position})` : ''}.
        </p>
        {errorMsg && (
          <div className="al d" role="alert">
            <span className="i" />
            <div className="tx">{errorMsg}</div>
          </div>
        )}
        <Field label="Remarks (recorded in the audit trail)" htmlFor="wfNote">
          <textarea
            id="wfNote"
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            placeholder="Title verified, survey area confirmed…"
          />
        </Field>
      </Modal>

      <Modal
        open={cancelModalOpen}
        stacked
        size="sm"
        icon="alert"
        title={`Cancel case ${caseCode}`}
        onClose={() => setCancelModalOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-s" onClick={() => setCancelModalOpen(false)}>
              Keep Active
            </button>
            <button
              type="button"
              className="btn btn-d"
              onClick={() => handleAdvance('Cancelled', 'Manager Land (HO)')}
              disabled={advancing || !remarks.trim()}
            >
              {advancing ? 'Cancelling…' : 'Confirm Cancellation'}
            </button>
          </>
        }
      >
        <p className="u-mb-10">
          Cancelling case <span className="code">{caseCode}</span> permanently closes its workflow. Provide a formal
          cancellation reason for the audit trail.
        </p>
        {errorMsg && (
          <div className="al d" role="alert">
            <span className="i" />
            <div className="tx">{errorMsg}</div>
          </div>
        )}
        <Field label="Formal Cancellation Reason *" htmlFor="wfCancelNote">
          <textarea
            id="wfCancelNote"
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            placeholder="State reason for cancelling this compensation case…"
          />
        </Field>
      </Modal>
    </div>
  );
}
