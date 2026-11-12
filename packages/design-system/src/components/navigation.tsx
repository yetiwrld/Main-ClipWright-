import React from 'react';
import clsx from 'clsx';
import { Check, AlertCircle, ChevronRight } from 'lucide-react';

export interface Step { id: string; label: string; }
export function Stepper({ steps, activeIndex, furthestCompleted, errorIndex, onStepClick, running }: {
  steps: Step[]; activeIndex: number; furthestCompleted: number;
  errorIndex?: number; onStepClick?: (index: number) => void; running?: boolean;
}) {
  return (
    <nav className="cw-stepper" aria-label="Workflow steps">
      {steps.map((step, i) => {
        const state = errorIndex === i ? 'error'
          : i < activeIndex ? 'done'
          : i === activeIndex ? 'active'
          : 'todo';
        const clickable = state === 'done' && onStepClick;
        return (
          <React.Fragment key={step.id}>
            {i > 0 && <ChevronRight size={14} className="cw-step-arrow" aria-hidden="true" />}
            <button
              className={clsx('cw-step', state === 'done' && 'cw-step--done', state === 'active' && 'cw-step--active', state === 'error' && 'cw-step--error')}
              aria-current={state === 'active' ? 'step' : undefined}
              disabled={state === 'todo' || errorIndex === i}
              title={state === 'todo' ? 'Finish the previous step first' : undefined}
              onClick={clickable ? () => onStepClick(i) : undefined}
            >
              {state === 'done' && <Check size={14} aria-hidden="true" />}
              {state === 'error' && <AlertCircle size={14} aria-hidden="true" />}
              {state === 'active' && running && <span className="cw-spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} aria-hidden="true" />}
              {step.label}
            </button>
          </React.Fragment>
        );
      })}
    </nav>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: React.ReactNode }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="cw-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}
