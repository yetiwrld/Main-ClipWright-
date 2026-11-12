import React from 'react';
import clsx from 'clsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = '28' | '32' | '36' | '44';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
}

export function Button({ variant = 'secondary', size = '32', loading, fullWidth, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      className={clsx('cw-btn', `cw-btn--${variant}`, `cw-btn--${size}`, fullWidth && 'cw-btn--full', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="cw-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  'aria-label': string;
  size?: '16' | '20' | '24' | '32';
  active?: boolean;
}

export function IconButton({ size = '20', active, className, children, ...rest }: IconButtonProps) {
  return (
    <button
      className={clsx('cw-icon-btn', size !== '20' && `cw-icon-btn--${size}`, active && 'cw-icon-btn--active', className)}
      aria-pressed={active || undefined}
      {...rest}
    >
      {children}
    </button>
  );
}
