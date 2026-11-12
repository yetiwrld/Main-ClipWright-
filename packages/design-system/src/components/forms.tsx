import React from 'react';
import clsx from 'clsx';

export interface FieldProps {
  label?: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: React.ReactNode;
}
export function Field({ label, hint, error, htmlFor, children }: FieldProps) {
  return (
    <div className="cw-field">
      {label && <label className="cw-field-label" htmlFor={htmlFor}>{label}</label>}
      {children}
      {error ? <div className="cw-field-error" role="alert">{error}</div>
        : hint ? <div className="cw-field-hint">{hint}</div> : null}
    </div>
  );
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { error?: boolean }>(
  function Input({ error, className, ...rest }, ref) {
    return <input ref={ref} className={clsx('cw-input', error && 'cw-input--error', className)} {...rest} />;
  });

export const TextArea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={clsx('cw-textarea', className)} {...rest} />;
  });

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return <select ref={ref} className={clsx('cw-select', className)} {...rest}>{children}</select>;
  });

export interface ToggleProps { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; 'aria-label'?: string; }
export function Toggle({ checked, onChange, disabled, ...rest }: ToggleProps) {
  return (
    <button
      type="button" role="switch" className="cw-toggle" aria-checked={checked} disabled={disabled}
      {...rest}
      onClick={() => onChange(!checked)}
    />
  );
}

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> { label?: React.ReactNode; }
export function Checkbox({ label, className, ...rest }: CheckboxProps) {
  const box = <input type="checkbox" className={clsx('cw-checkbox', className)} {...rest} />;
  if (!label) return box;
  return <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>{box}<span>{label}</span></label>;
}

export interface RadioProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> { label?: React.ReactNode; }
export function Radio({ label, className, ...rest }: RadioProps) {
  const box = <input type="radio" className={clsx('cw-radio', className)} {...rest} />;
  if (!label) return box;
  return <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>{box}<span>{label}</span></label>;
}

export interface SliderProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {}
export function Slider({ className, ...rest }: SliderProps) {
  return <input type="range" className={clsx('cw-slider', className)} {...rest} />;
}

export interface SegmentedProps<T extends string> {
  options: readonly { value: T; label: React.ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  'aria-label'?: string;
}
export function Segmented<T extends string>({ options, value, onChange, ...rest }: SegmentedProps<T>) {
  return (
    <div className="cw-segmented" role="group" {...rest}>
      {options.map((o) => (
        <button key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}
