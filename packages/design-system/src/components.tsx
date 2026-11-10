import { Pipette } from 'lucide-react';
import { canPickFromScreen, pickColour } from './eyedropper.js';
import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  createContext,
  useContext,
} from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Search,
  X,
  AlertCircle,
  CheckCircle2,
  Info,
  AlertTriangle,
} from 'lucide-react';

// Shared tooltip warm-state so moving between neighbours has 0ms delay (Spec 01 §7)
let lastTooltipClosedAt = 0;

/* ============================================================================
 * 1. BUTTON
 * ========================================================================== */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 28 | 32 | 36 | 44;
  loading?: boolean;
  icon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'secondary',
      size = 32,
      loading = false,
      icon,
      children,
      disabled,
      style,
      onMouseEnter,
      onMouseLeave,
      onMouseDown,
      onMouseUp,
      ...rest
    },
    ref
  ) => {
    const [hovered, setHovered] = useState(false);
    const [pressed, setPressed] = useState(false);
    const isDisabled = disabled || loading;

    const getBg = () => {
      if (variant === 'primary') return hovered && !isDisabled ? 'var(--brand-strong)' : 'var(--brand)';
      if (variant === 'danger') return hovered && !isDisabled ? 'var(--error)' : 'var(--error-tint)';
      if (variant === 'ghost') {
        if (pressed && !isDisabled) return 'var(--surface-pressed)';
        return hovered && !isDisabled ? 'var(--surface-hover)' : 'transparent';
      }
      if (pressed && !isDisabled) return 'var(--surface-pressed)';
      return hovered && !isDisabled ? 'var(--surface-hover)' : 'var(--surface-card)';
    };

    const getColor = () => {
      if (isDisabled && variant !== 'primary') return 'var(--text-disabled)';
      if (variant === 'primary') return 'var(--on-brand)';
      if (variant === 'danger') return hovered && !isDisabled ? 'var(--on-brand)' : 'var(--error)';
      return 'var(--text-primary)';
    };

    const paddingMap: Record<number, string> = {
      28: '0 var(--space-2)',
      32: '0 var(--space-3)',
      36: '0 var(--space-4)',
      44: '0 var(--space-6)',
    };

    return (
      <button
        ref={ref}
        type="button"
        disabled={isDisabled}
        aria-busy={loading || undefined}
        onMouseEnter={(e) => {
          setHovered(true);
          onMouseEnter?.(e);
        }}
        onMouseLeave={(e) => {
          setHovered(false);
          setPressed(false);
          onMouseLeave?.(e);
        }}
        onMouseDown={(e) => {
          setPressed(true);
          onMouseDown?.(e);
        }}
        onMouseUp={(e) => {
          setPressed(false);
          onMouseUp?.(e);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 'var(--space-2)',
          height: `${size}px`,
          minWidth: `${Math.max(32, size)}px`,
          padding: paddingMap[size],
          borderRadius: variant === 'primary' ? 'var(--radius-pill)' : 'var(--radius-sm)',
          border: 'none',
          background: getBg(),
          color: getColor(),
          fontFamily: 'var(--font-sans)',
          fontSize: size === 28 ? 'var(--fs-sm)' : 'var(--fs-md)',
          fontWeight: 500,
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          opacity: isDisabled ? 0.55 : 1,
          transform: pressed && !isDisabled ? 'scale(0.99)' : 'scale(1)',
          boxShadow:
            variant === 'primary' && hovered && !isDisabled ? 'var(--glow-brand-hover)' : 'none',
          transition:
            'background var(--dur-fast) var(--ease-standard), transform var(--dur-fast) var(--ease-standard), box-shadow var(--dur-fast) var(--ease-standard)',
          whiteSpace: 'nowrap',
          ...style,
        }}
        {...rest}
      >
        {loading ? (
          <Loader2
            size={16}
            style={{ animation: 'cw-spin 800ms linear infinite', flexShrink: 0 }}
          />
        ) : (
          icon && <span style={{ display: 'inline-flex', flexShrink: 0 }}>{icon}</span>
        )}
        <span>{children}</span>
      </button>
    );
  }
);
Button.displayName = 'Button';

/* ============================================================================
 * 2. ICON BUTTON
 * ========================================================================== */
export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  shortcut?: string;
  active?: boolean;
  size?: 28 | 32;
  icon: React.ReactNode;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, shortcut, active = false, size = 32, icon, disabled, style, ...rest }, ref) => {
    const [hovered, setHovered] = useState(false);
    const [pressed, setPressed] = useState(false);

    const getBg = () => {
      if (active) return hovered && !disabled ? 'var(--brand-tint-strong)' : 'var(--brand-tint)';
      if (pressed && !disabled) return 'var(--surface-pressed)';
      if (hovered && !disabled) return 'var(--surface-hover)';
      return 'transparent';
    };

    const tooltipText = shortcut ? `${label} (${shortcut})` : label;

    return (
      <Tooltip content={tooltipText}>
        <button
          ref={ref}
          type="button"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => {
            setHovered(false);
            setPressed(false);
          }}
          onMouseDown={() => setPressed(true)}
          onMouseUp={() => setPressed(false)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: `${size}px`,
            height: `${size}px`,
            minWidth: '32px',
            minHeight: '32px',
            padding: 0,
            borderRadius: 'var(--radius-sm)',
            border: 'none',
            background: getBg(),
            color: disabled
              ? 'var(--text-disabled)'
              : active
                ? 'var(--text-brand)'
                : 'var(--text-primary)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            transform: pressed && !disabled ? 'scale(0.99)' : 'scale(1)',
            transition:
              'background var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard)',
            flexShrink: 0,
            ...style,
          }}
          {...rest}
        >
          {icon}
        </button>
      </Tooltip>
    );
  }
);
IconButton.displayName = 'IconButton';

/* ============================================================================
 * 3. INPUT & TEXTAREA
 * ========================================================================== */
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  leftIcon?: React.ReactNode;
  rightSlot?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ error, leftIcon, rightSlot, style, onFocus, onBlur, ...rest }, ref) => {
    const [focused, setFocused] = useState(false);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', width: '100%' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            height: '32px',
            padding: '0 var(--space-2)',
            background: 'var(--surface-card)',
            border: `1px solid ${
              error ? 'var(--error)' : focused ? 'var(--brand)' : 'var(--line-default)'
            }`,
            borderRadius: 'var(--radius-sm)',
            transition: 'border-color var(--dur-fast) var(--ease-standard)',
          }}
        >
          {leftIcon && (
            <span style={{ color: 'var(--text-muted)', display: 'inline-flex' }}>{leftIcon}</span>
          )}
          <input
            ref={ref}
            aria-invalid={!!error}
            onFocus={(e) => {
              setFocused(true);
              onFocus?.(e);
            }}
            onBlur={(e) => {
              setFocused(false);
              onBlur?.(e);
            }}
            style={{
              flex: 1,
              width: '100%',
              height: '100%',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-sm)',
              ...style,
            }}
            {...rest}
          />
          {rightSlot && <span style={{ display: 'inline-flex' }}>{rightSlot}</span>}
        </div>
        {error && (
          <span
            role="alert"
            style={{
              color: 'var(--error)',
              fontSize: 'var(--fs-xs)',
              lineHeight: 'var(--lh-xs)',
            }}
          >
            {error}
          </span>
        )}
      </div>
    );
  }
);
Input.displayName = 'Input';

export interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: string;
}

export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ error, style, onFocus, onBlur, ...rest }, ref) => {
    const [focused, setFocused] = useState(false);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', width: '100%' }}>
        <textarea
          ref={ref}
          aria-invalid={!!error}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={{
            width: '100%',
            minHeight: '64px',
            padding: 'var(--space-2)',
            background: 'var(--surface-card)',
            border: `1px solid ${
              error ? 'var(--error)' : focused ? 'var(--brand)' : 'var(--line-default)'
            }`,
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-sm)',
            resize: 'vertical',
            outline: 'none',
            transition: 'border-color var(--dur-fast) var(--ease-standard)',
            ...style,
          }}
          {...rest}
        />
        {error && (
          <span role="alert" style={{ color: 'var(--error)', fontSize: 'var(--fs-xs)' }}>
            {error}
          </span>
        )}
      </div>
    );
  }
);
TextArea.displayName = 'TextArea';

/* ============================================================================
 * 4. SELECT / COMBOBOX
 * ========================================================================== */
export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  searchable?: boolean;
}

export const Select: React.FC<SelectProps> = ({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  ariaLabel,
  disabled = false,
  searchable,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);
  const showSearch = searchable ?? options.length > 8;
  const filtered = showSearch
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handleOutside);
    return () => window.removeEventListener('mousedown', handleOutside);
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <button
        type="button"
        aria-label={ariaLabel || placeholder}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          height: '32px',
          padding: '0 var(--space-2)',
          background: 'var(--surface-card)',
          border: '1px solid var(--line-default)',
          borderRadius: 'var(--radius-sm)',
          color: disabled ? 'var(--text-disabled)' : 'var(--text-primary)',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--fs-sm)',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={16} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + var(--space-1))',
            left: 0,
            right: 0,
            zIndex: 100,
            background: 'var(--surface-card)',
            border: '1px solid var(--line-default)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-menu)',
            padding: 'var(--space-1)',
            maxHeight: '260px',
            overflowY: 'auto',
          }}
        >
          {showSearch && (
            <div style={{ paddingBottom: 'var(--space-1)' }}>
              <Input
                placeholder="Search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                leftIcon={<Search size={14} />}
              />
            </div>
          )}
          {filtered.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={opt.disabled}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                  setQuery('');
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  height: '32px',
                  padding: '0 var(--space-2)',
                  background: isSelected ? 'var(--brand-tint)' : 'transparent',
                  border: 'none',
                  borderRadius: 'var(--radius-xs)',
                  color: opt.disabled
                    ? 'var(--text-disabled)'
                    : isSelected
                      ? 'var(--text-brand)'
                      : 'var(--text-primary)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 'var(--fs-sm)',
                  cursor: opt.disabled ? 'not-allowed' : 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {opt.label}
                </span>
                {opt.hint && (
                  <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>
                    {opt.hint}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const Combobox = Select;

/* ============================================================================
 * 5. SLIDER
 * ========================================================================== */
export interface SliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  formatValue?: (v: number) => string;
  disabled?: boolean;
}

export const Slider: React.FC<SliderProps> = ({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  ariaLabel,
  formatValue,
  disabled = false,
}) => {
  const [dragging, setDragging] = useState(false);
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min || 1)) * 100));

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        height: '32px',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '6px',
          background: 'var(--surface-pressed)',
          borderRadius: 'var(--radius-pill)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${pct}%`,
            background: disabled ? 'var(--text-disabled)' : 'var(--brand)',
            borderRadius: 'var(--radius-pill)',
          }}
        />
      </div>
      <input
        type="range"
        aria-label={ariaLabel}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onMouseDown={() => setDragging(true)}
        onMouseUp={() => setDragging(false)}
        onBlur={() => setDragging(false)}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          opacity: 0,
          cursor: disabled ? 'not-allowed' : 'pointer',
          margin: 0,
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: `calc(${pct}% - 7px)`,
          width: '14px',
          height: '14px',
          borderRadius: 'var(--radius-pill)',
          background: disabled ? 'var(--text-disabled)' : 'var(--text-primary)',
          border: '2px solid var(--brand)',
          pointerEvents: 'none',
        }}
      />
      {dragging && (
        <div
          style={{
            position: 'absolute',
            bottom: '30px',
            left: `calc(${pct}% - 20px)`,
            padding: '2px var(--space-1)',
            background: 'var(--surface-card)',
            borderRadius: 'var(--radius-xs)',
            color: 'var(--text-primary)',
            fontSize: 'var(--fs-xs)',
            fontFamily: 'var(--font-mono)',
            boxShadow: 'var(--shadow-menu)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {formatValue ? formatValue(value) : value}
        </div>
      )}
    </div>
  );
};

/* ============================================================================
 * 6. TOGGLE
 * ========================================================================== */
export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

export const Toggle: React.FC<ToggleProps> = ({
  checked,
  onChange,
  label,
  ariaLabel,
  disabled = false,
}) => {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        minHeight: '32px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? 'var(--text-disabled)' : 'var(--text-primary)',
        fontSize: 'var(--fs-sm)',
      }}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel || label || 'Toggle'}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        style={{
          position: 'relative',
          width: '36px',
          height: '20px',
          padding: '2px',
          borderRadius: 'var(--radius-pill)',
          border: 'none',
          background: checked ? 'var(--brand)' : 'var(--surface-pressed)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          transition: 'background var(--dur-fast) var(--ease-standard)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            display: 'block',
            width: '16px',
            height: '16px',
            borderRadius: 'var(--radius-pill)',
            background: checked ? 'var(--on-brand)' : 'var(--text-primary)',
            transform: checked ? 'translateX(16px)' : 'translateX(0)',
            transition: 'transform var(--dur-fast) var(--ease-standard)',
          }}
        />
      </button>
      {label && <span>{label}</span>}
    </label>
  );
};

/* ============================================================================
 * 7. CHECKBOX & RADIO
 * ========================================================================== */
export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

export const Checkbox: React.FC<CheckboxProps> = ({
  checked,
  onChange,
  label,
  ariaLabel,
  disabled = false,
}) => {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        minHeight: '32px',
        minWidth: '32px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? 'var(--text-disabled)' : 'var(--text-primary)',
        fontSize: 'var(--fs-sm)',
      }}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={ariaLabel || label || 'Checkbox'}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) onChange(!checked);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '16px',
          height: '16px',
          padding: 0,
          borderRadius: 'var(--radius-xs)',
          border: `1px solid ${checked ? 'var(--brand)' : 'var(--line-default)'}`,
          background: checked ? 'var(--brand)' : 'var(--surface-card)',
          color: 'var(--on-brand)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          flexShrink: 0,
        }}
      >
        {checked && <Check size={12} strokeWidth={2.5} />}
      </button>
      {label && <span>{label}</span>}
    </label>
  );
};

export interface RadioProps {
  checked: boolean;
  onChange: () => void;
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

export const Radio: React.FC<RadioProps> = ({
  checked,
  onChange,
  label,
  ariaLabel,
  disabled = false,
}) => {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        minHeight: '32px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? 'var(--text-disabled)' : 'var(--text-primary)',
        fontSize: 'var(--fs-sm)',
      }}
    >
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label={ariaLabel || label || 'Radio'}
        disabled={disabled}
        onClick={() => !disabled && onChange()}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '16px',
          height: '16px',
          padding: 0,
          borderRadius: 'var(--radius-pill)',
          border: `1px solid ${checked ? 'var(--brand)' : 'var(--line-default)'}`,
          background: 'var(--surface-card)',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {checked && (
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: 'var(--radius-pill)',
              background: 'var(--brand)',
            }}
          />
        )}
      </button>
      {label && <span>{label}</span>}
    </label>
  );
};

/* ============================================================================
 * 8. SEGMENTED CONTROL & 9. TABS
 * ========================================================================== */
export interface SegmentOption<T extends string = string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  ariaLabel?: string;
  size?: 'dense' | 'default';
}

export function SegmentedControl<T extends string = string>({
  value,
  onChange,
  options,
  ariaLabel,
  size = 'default',
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel || 'Segmented control'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '2px',
        padding: '2px',
        background: 'var(--surface-card)',
        borderRadius: 'var(--radius-pill)',
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={opt.disabled}
            onClick={() => !opt.disabled && onChange(opt.value)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              height: size === 'dense' ? '28px' : '32px',
              padding: '0 var(--space-3)',
              borderRadius: 'var(--radius-pill)',
              border: 'none',
              background: active ? 'var(--brand-tint)' : 'transparent',
              color: opt.disabled
                ? 'var(--text-disabled)'
                : active
                  ? 'var(--text-brand)'
                  : 'var(--text-secondary)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-xs)',
              fontWeight: active ? 600 : 500,
              cursor: opt.disabled ? 'not-allowed' : 'pointer',
              transition: 'background var(--dur-fast) var(--ease-standard)',
              whiteSpace: 'nowrap',
            }}
          >
            {opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface TabItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  badge?: string | number;
}

export interface TabsProps {
  tabs: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
}

export const Tabs: React.FC<TabsProps> = ({ tabs, activeId, onChange, ariaLabel }) => {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel || 'Tabs'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        flexWrap: 'wrap',
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              height: '32px',
              padding: '0 var(--space-3)',
              borderRadius: 'var(--radius-pill)',
              border: 'none',
              background: active ? 'var(--brand-tint)' : 'transparent',
              color: active ? 'var(--text-brand)' : 'var(--text-secondary)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-sm)',
              fontWeight: active ? 600 : 500,
              cursor: 'pointer',
              transition: 'background var(--dur-fast) var(--ease-standard)',
            }}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.badge !== undefined && (
              <span
                style={{
                  padding: '0 6px',
                  borderRadius: 'var(--radius-pill)',
                  background: 'var(--surface-card)',
                  fontSize: 'var(--fs-xs)',
                }}
              >
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

/* ============================================================================
 * 10. TOOLTIP
 * ========================================================================== */
export interface TooltipProps {
  content: string;
  children: React.ReactElement;
}

export const Tooltip: React.FC<TooltipProps> = ({ content, children }) => {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    const now = Date.now();
    const delay = now - lastTooltipClosedAt < 350 ? 0 : 500;
    timerRef.current = setTimeout(() => setVisible(true), delay);
  };

  const hide = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (visible) lastTooltipClosedAt = Date.now();
    setVisible(false);
  };

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {visible && content && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 200,
            padding: 'var(--space-1) var(--space-2)',
            background: 'var(--surface-card)',
            border: '1px solid var(--line-default)',
            borderRadius: 'var(--radius-xs)',
            color: 'var(--text-primary)',
            fontSize: 'var(--fs-xs)',
            lineHeight: 'var(--lh-xs)',
            whiteSpace: 'nowrap',
            boxShadow: 'var(--shadow-menu)',
            pointerEvents: 'none',
          }}
        >
          {content}
        </span>
      )}
    </span>
  );
};

/* ============================================================================
 * 11. CONTEXT MENU / MENU
 * ========================================================================== */
export interface MenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  disabledReason?: string;
  danger?: boolean;
  separatorBefore?: boolean;
  onSelect?: () => void;
}

export interface MenuProps {
  items: MenuItem[];
  onClose: () => void;
  x?: number;
  y?: number;
}

export const Menu: React.FC<MenuProps> = ({ items, onClose, x, y }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{
        position: x !== undefined && y !== undefined ? 'fixed' : 'absolute',
        left: x !== undefined ? `${x}px` : 0,
        top: y !== undefined ? `${y}px` : 'calc(100% + 4px)',
        zIndex: 300,
        minWidth: '210px',
        padding: 'var(--space-1)',
        background: 'var(--surface-card)',
        border: '1px solid var(--line-default)',
        borderRadius: 'var(--radius-sm)',
        boxShadow: 'var(--shadow-menu)',
      }}
    >
      {items.map((item) => (
        <React.Fragment key={item.id}>
          {item.separatorBefore && (
            <div
              role="separator"
              style={{
                height: '1px',
                background: 'var(--line-faint)',
                margin: 'var(--space-1) 0',
              }}
            />
          )}
          <Tooltip content={item.disabled && item.disabledReason ? item.disabledReason : ''}>
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                if (!item.disabled) {
                  item.onSelect?.();
                  onClose();
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--space-4)',
                width: '100%',
                height: '32px',
                padding: '0 var(--space-2)',
                background: 'transparent',
                border: 'none',
                borderRadius: 'var(--radius-xs)',
                color: item.disabled
                  ? 'var(--text-disabled)'
                  : item.danger
                    ? 'var(--error)'
                    : 'var(--text-primary)',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-sm)',
                cursor: item.disabled ? 'not-allowed' : 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                {item.icon}
                <span>{item.label}</span>
              </span>
              {item.shortcut && (
                <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>
                  {item.shortcut}
                </span>
              )}
            </button>
          </Tooltip>
        </React.Fragment>
      ))}
    </div>
  );
};

export const ContextMenu = Menu;

/* ============================================================================
 * 12. DIALOG
 * ========================================================================== */
export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: number;
}

export const Dialog: React.FC<DialogProps> = ({
  open,
  title,
  onClose,
  children,
  footer,
  maxWidth = 520,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 400,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--surface-overlay)',
        padding: 'var(--space-6)',
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: `${maxWidth}px`,
          background: 'var(--surface-card)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-dialog)',
          padding: 'var(--space-6)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 'var(--fs-lg)',
              lineHeight: 'var(--lh-lg)',
              fontWeight: 600,
            }}
          >
            {title}
          </h2>
          <IconButton label="Close dialog" shortcut="Esc" icon={<X size={18} />} onClick={onClose} />
        </div>
        <div style={{ fontSize: 'var(--fs-md)', color: 'var(--text-secondary)' }}>{children}</div>
        {footer && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 'var(--space-2)',
              paddingTop: 'var(--space-2)',
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

/* ============================================================================
 * 13. TOAST / NOTIFICATION
 * ========================================================================== */
export interface ToastItem {
  id: string;
  message: string;
  tone?: 'neutral' | 'success' | 'warning' | 'error' | 'info';
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastContextValue {
  pushToast: (toast: Omit<ToastItem, 'id'>) => void;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue>({
  pushToast: () => {},
  dismissToast: () => {},
});

export const useToast = () => useContext(ToastContext);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (toast: Omit<ToastItem, 'id'>) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev, { ...toast, id }]);
      if (toast.tone !== 'error') {
        setTimeout(() => dismissToast(id), 4000);
      }
    },
    [dismissToast]
  );

  return (
    <ToastContext.Provider value={{ pushToast, dismissToast }}>
      {children}
      <div
        aria-live="polite"
        style={{
          position: 'fixed',
          bottom: 'var(--space-4)',
          right: 'var(--space-4)',
          zIndex: 500,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          maxWidth: '380px',
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-3)',
              padding: 'var(--space-3) var(--space-4)',
              background: 'var(--surface-card)',
              border: `1px solid ${
                t.tone === 'error' ? 'var(--error)' : 'var(--line-default)'
              }`,
              borderRadius: 'var(--radius-sm)',
              boxShadow: 'var(--shadow-menu)',
              color: 'var(--text-primary)',
              fontSize: 'var(--fs-sm)',
            }}
          >
            <span>{t.message}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
              {t.actionLabel && (
                <Button
                  size={28}
                  variant="ghost"
                  onClick={() => {
                    t.onAction?.();
                    dismissToast(t.id);
                  }}
                >
                  {t.actionLabel}
                </Button>
              )}
              <IconButton
                size={28}
                label="Dismiss notification"
                icon={<X size={14} />}
                onClick={() => dismissToast(t.id)}
              />
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

/* ============================================================================
 * 14. PROGRESS LINEAR + RING
 * ========================================================================== */
export interface ProgressProps {
  value?: number; // 0..100, undefined = indeterminate
  size?: number;
  showLabel?: boolean;
  ariaLabel?: string;
}

export const ProgressLinear: React.FC<ProgressProps> = ({
  value,
  showLabel = true,
  ariaLabel = 'Progress',
}) => {
  const clamped = value !== undefined ? Math.max(0, Math.min(100, value)) : undefined;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', width: '100%' }}>
      <div
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuenow={clamped !== undefined ? Math.round(clamped) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          flex: 1,
          height: '8px',
          background: 'var(--surface-pressed)',
          borderRadius: 'var(--radius-pill)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: clamped !== undefined ? `${clamped}%` : '40%',
            background: 'linear-gradient(90deg, var(--brand-strong), var(--brand-amber))',
            borderRadius: 'var(--radius-pill)',
            transition: 'width var(--dur-base) var(--ease-standard)',
            animation: clamped === undefined ? 'cw-shimmer 1600ms ease-in-out infinite' : undefined,
          }}
        />
      </div>
      {showLabel && clamped !== undefined && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-xs)',
            color: 'var(--text-secondary)',
            minWidth: '36px',
            textAlign: 'right',
          }}
        >
          {Math.round(clamped)}%
        </span>
      )}
    </div>
  );
};

export const ProgressRing: React.FC<ProgressProps> = ({
  value,
  size = 120,
  showLabel = true,
  ariaLabel = 'Progress',
}) => {
  const stroke = 8;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const clamped = value !== undefined ? Math.max(0, Math.min(100, value)) : 25;
  const offset = circ - (clamped / 100) * circ;

  return (
    <div
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuenow={value !== undefined ? Math.round(clamped) : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: `${size}px`,
        height: `${size}px`,
      }}
    >
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--surface-pressed)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--brand)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset var(--dur-base) var(--ease-standard)' }}
        />
      </svg>
      {showLabel && (
        <span
          style={{
            position: 'absolute',
            fontFamily: 'var(--font-sans)',
            fontSize: size >= 110 ? 'var(--fs-hero)' : 'var(--fs-md)',
            fontWeight: 700,
            color: 'var(--text-primary)',
          }}
        >
          {value !== undefined ? `${Math.round(clamped)}%` : '…'}
        </span>
      )}
    </div>
  );
};

/* ============================================================================
 * 15. SKELETON & 16. EMPTY STATE & 17. CARD & 18. CHIP / BADGE
 * ========================================================================== */
export const Skeleton: React.FC<{
  width?: string | number;
  height?: string | number;
  radius?: string;
}> = ({ width = '100%', height = 20, radius = 'var(--radius-sm)' }) => (
  <div
    aria-hidden="true"
    style={{
      width: typeof width === 'number' ? `${width}px` : width,
      height: typeof height === 'number' ? `${height}px` : height,
      borderRadius: radius,
      background: 'var(--surface-hover)',
      animation: 'cw-shimmer 1600ms ease-in-out infinite',
    }}
  />
);

export interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  explanation: string;
  actionLabel?: string;
  onAction?: () => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  explanation,
  actionLabel,
  onAction,
}) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 'var(--space-2)',
      padding: 'var(--space-8)',
      textAlign: 'center',
    }}
  >
    <div style={{ color: 'var(--text-muted)' }}>{icon}</div>
    <div style={{ fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--text-primary)' }}>
      {title}
    </div>
    <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', maxWidth: '380px' }}>
      {explanation}
    </div>
    {actionLabel && onAction && (
      <div style={{ paddingTop: 'var(--space-2)' }}>
        <Button variant="secondary" onClick={onAction}>
          {actionLabel}
        </Button>
      </div>
    )}
  </div>
);

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'moment' | 'selected';
}

export const Card: React.FC<CardProps> = ({
  variant = 'default',
  children,
  style,
  ...rest
}) => (
  <div
    style={{
      background: 'var(--surface-card)',
      borderRadius: variant === 'moment' ? 'var(--radius-lg)' : 'var(--radius-md)',
      padding: 'var(--space-4)',
      boxShadow:
        variant === 'selected'
          ? 'inset 0 0 0 2px var(--brand)'
          : 'var(--highlight-top)',
      ...style,
    }}
    {...rest}
  >
    {children}
  </div>
);

export interface ChipProps {
  children: React.ReactNode;
  variant?: 'neutral' | 'brand' | 'success' | 'warning' | 'error' | 'info';
  onClick?: () => void;
}

export const Chip: React.FC<ChipProps> = ({ children, variant = 'neutral', onClick }) => {
  const styles: Record<string, { bg: string; color: string; icon?: React.ReactNode }> = {
    neutral: { bg: 'var(--surface-hover)', color: 'var(--text-secondary)' },
    brand: { bg: 'var(--brand-tint)', color: 'var(--text-brand)' },
    success: {
      bg: 'var(--success-tint)',
      color: 'var(--success)',
      icon: <CheckCircle2 size={12} />,
    },
    warning: {
      bg: 'var(--warning-tint)',
      color: 'var(--warning)',
      icon: <AlertTriangle size={12} />,
    },
    error: {
      bg: 'var(--error-tint)',
      color: 'var(--error)',
      icon: <AlertCircle size={12} />,
    },
    info: { bg: 'var(--info-tint)', color: 'var(--info)', icon: <Info size={12} /> },
  };
  const s = styles[variant] || styles.neutral;

  return (
    <span
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        height: '22px',
        padding: '0 var(--space-2)',
        borderRadius: 'var(--radius-pill)',
        background: s.bg,
        color: s.color,
        fontSize: 'var(--fs-xs)',
        fontWeight: 500,
        cursor: onClick ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
      }}
    >
      {s.icon}
      <span>{children}</span>
    </span>
  );
};

export const Badge = Chip;

/* ============================================================================
 * 19. SCORE RING (Spec 01 §7: <50 muted, 50-74 info, 75-89 brand, >=90 brand-amber)
 * ========================================================================== */
export interface ScoreRingProps {
  score: number;
  size?: number;
  lowConfidence?: boolean;
}

export const ScoreRing: React.FC<ScoreRingProps> = ({
  score,
  size = 44,
  lowConfidence = false,
}) => {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const stroke = 4;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (clamped / 100) * circ;

  const getColor = () => {
    if (lowConfidence || clamped < 50) return 'var(--text-muted)';
    if (clamped < 75) return 'var(--info)';
    if (clamped < 90) return 'var(--brand)';
    return 'var(--brand-amber)';
  };

  return (
    <div
      aria-label={`Moment score ${clamped} out of 100`}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: `${size}px`,
        height: `${size}px`,
        flexShrink: 0,
      }}
    >
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--surface-pressed)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={getColor()}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
        />
      </svg>
      <span
        style={{
          position: 'absolute',
          fontSize: 'var(--fs-xs)',
          fontWeight: 600,
          color: 'var(--text-primary)',
        }}
      >
        {clamped}
      </span>
    </div>
  );
};

/* ============================================================================
 * 20. STEPPER (Spec 01 §7 & Spec 02 §3)
 * ========================================================================== */
export interface StepDefinition {
  id: 'import' | 'transcribe' | 'moments' | 'editor';
  label: string;
  state: 'completed' | 'active' | 'running' | 'not_reached' | 'error';
}

export interface StepperProps {
  steps: StepDefinition[];
  onSelectStep: (id: StepDefinition['id']) => void;
}

export const Stepper: React.FC<StepperProps> = ({ steps, onSelectStep }) => {
  return (
    <nav aria-label="Project workflow steps" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
      {steps.map((step, idx) => {
        const isClickable = step.state === 'completed' || step.state === 'error' || step.state === 'active';
        const isActive = step.state === 'active' || step.state === 'running';
        const btn = (
          <button
            key={step.id}
            type="button"
            disabled={!isClickable}
            aria-current={isActive ? 'step' : undefined}
            onClick={() => isClickable && onSelectStep(step.id)}
            style={{
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              height: '32px',
              padding: '0 var(--space-3)',
              borderRadius: 'var(--radius-pill)',
              border: 'none',
              background: isActive ? 'var(--brand-tint)' : 'transparent',
              color:
                step.state === 'error'
                  ? 'var(--error)'
                  : isActive
                    ? 'var(--text-brand)'
                    : step.state === 'completed'
                      ? 'var(--text-primary)'
                      : 'var(--text-muted)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-xs)',
              fontWeight: isActive ? 600 : 500,
              cursor: isClickable ? 'pointer' : 'not-allowed',
              transition: 'background var(--dur-slow) var(--ease-standard)',
            }}
          >
            {step.state === 'completed' && <Check size={14} />}
            {step.state === 'error' && <AlertCircle size={14} />}
            <span>{step.label}</span>
            {step.state === 'running' && (
              <span
                style={{
                  position: 'absolute',
                  left: 'var(--space-3)',
                  right: 'var(--space-3)',
                  bottom: '2px',
                  height: '2px',
                  background: 'var(--brand)',
                  borderRadius: 'var(--radius-pill)',
                }}
              />
            )}
          </button>
        );

        return (
          <React.Fragment key={step.id}>
            {step.state === 'not_reached' ? (
              <Tooltip content="Finish the previous step first">{btn}</Tooltip>
            ) : (
              btn
            )}
            {idx < steps.length - 1 && (
              <ChevronRight size={14} style={{ color: 'var(--text-disabled)' }} />
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
};

/* ============================================================================
 * 21. PANEL HEADER & 22. SPLITTER
 * ========================================================================== */
export interface PanelHeaderProps {
  title: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  actions?: React.ReactNode;
}

export const PanelHeader: React.FC<PanelHeaderProps> = ({
  title,
  collapsed = false,
  onToggleCollapse,
  actions,
}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      height: '36px',
      padding: '0 var(--space-3)',
      borderBottom: '1px solid var(--line-faint)',
      flexShrink: 0,
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
      {onToggleCollapse && (
        <IconButton
          size={28}
          label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          icon={
            <ChevronDown
              size={14}
              style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
            />
          }
          onClick={onToggleCollapse}
        />
      )}
      <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
        {title}
      </span>
    </div>
    {actions && <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>{actions}</div>}
  </div>
);

export interface SplitterProps {
  orientation: 'vertical' | 'horizontal';
  onDelta: (deltaPx: number) => void;
  onReset: () => void;
  ariaLabel: string;
}

export const Splitter: React.FC<SplitterProps> = ({
  orientation,
  onDelta,
  onReset,
  ariaLabel,
}) => {
  const startRef = useRef<number | null>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startRef.current = orientation === 'vertical' ? e.clientX : e.clientY;
    const onMove = (ev: MouseEvent) => {
      if (startRef.current === null) return;
      const current = orientation === 'vertical' ? ev.clientX : ev.clientY;
      const delta = current - startRef.current;
      startRef.current = current;
      onDelta(delta);
    };
    const onUp = () => {
      startRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-orientation={orientation}
      onMouseDown={handleMouseDown}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (orientation === 'vertical') {
          if (e.key === 'ArrowLeft') onDelta(-16);
          if (e.key === 'ArrowRight') onDelta(16);
        } else {
          if (e.key === 'ArrowUp') onDelta(-16);
          if (e.key === 'ArrowDown') onDelta(16);
        }
      }}
      style={{
        width: orientation === 'vertical' ? 'var(--gutter-editor)' : '100%',
        height: orientation === 'horizontal' ? 'var(--gutter-editor)' : '100%',
        cursor: orientation === 'vertical' ? 'col-resize' : 'row-resize',
        background: 'var(--surface-app)',
        flexShrink: 0,
      }}
    />
  );
};

/* ============================================================================
 * 23. COLOUR PICKER & 24. TIMECODE FIELD & 25. KBD
 * ========================================================================== */
const DEFAULT_SWATCHES = [
  'var(--text-primary)',
  'var(--brand)',
  'var(--brand-amber)',
  'var(--success)',
  'var(--info)',
  'var(--error)',
];

export interface ColourPickerProps {
  value: string;
  onChange: (hex: string) => void;
  ariaLabel?: string;
  /**
   * The recent colours to show, newest first. Omit for a picker with no memory of its own —
   * the Brand Kit's colour fields share one list (below), so a colour picked for the primary
   * swatch is one click away for the accent.
   */
  recents?: readonly string[];
  /**
   * Reported after every committed colour, valid or not, so a caller can keep the shared list.
   * Called with the raw input: the caller decides when it is a complete colour, through
   * `addRecentColour`, which ignores anything half-typed.
   */
  onCommit?: (hex: string) => void;
}

/**
 * A colour field: the platform's colour input, a hex box, preset swatches, *recent* colours and —
 * in a Chromium build, which the desktop app is — the **eyedropper** (SPEC 01 §ColourPicker).
 *
 * The eyedropper is *absent* where the API does not exist rather than drawn disabled. A disabled
 * button is a promise that the control works somewhere; on a surface with no `EyeDropper` it
 * never will, and SPEC 13's rule about not showing unfinished tools as teasers applies to a
 * control that can never work as much as to one that is half-wired.
 */
export const ColourPicker: React.FC<ColourPickerProps> = ({
  value,
  onChange,
  ariaLabel = 'Colour hex value',
  recents = [],
  onCommit,
}) => {
  const [notice, setNotice] = React.useState('');
  const canPick = canPickFromScreen();
  /*
    The hex box keeps its own text while it is being typed in. Without a draft the box shows
    `value`, and every keystroke that the caller refuses — a half-typed `#FF`, which a style
    schema will not accept — would be erased under the cursor. The draft is re-synced whenever
    `value` changes from outside, so a pick or a swatch still updates the text.
  */
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = (hex: string) => {
    onChange(hex);
    onCommit?.(hex);
  };

  /*
    The pick runs on a click, which is a user gesture — the API requires one and throws without
    it. Cancelling (Esc) says nothing at all, which is what the user asked for; only a genuine
    failure gets a sentence.
  */
  const runEyedropper = async () => {
    const result = await pickColour();
    if (result.status === 'picked') {
      setNotice('');
      commit(result.hex);
      return;
    }
    if (result.status === 'cancelled' || result.status === 'unsupported') {
      setNotice('');
      return;
    }
    setNotice(result.message);
  };

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <input
          type="color"
          aria-label={ariaLabel}
          value={value.startsWith('#') && value.length === 7 ? value : undefined}
          onChange={(e) => commit(e.target.value.toUpperCase())}
          style={{
            width: '32px',
            height: '32px',
            padding: 0,
            border: '1px solid var(--line-default)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface-card)',
            cursor: 'pointer',
          }}
        />
        <Input
          /*
            "hex value", not "text". The label is what a screen reader announces and what the
            style editor's own tests had always used; a box called "Fill colour text" says nothing
            about what belongs in it, and two names for one control across two screens is how a
            component ends up being reached differently by automation in each.
          */
          aria-label={`${ariaLabel} hex value`}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            /*
              Every keystroke is reported — a caller that wants live updates gets them — but a
              caller that validates (the caption style editor does, because its schema refuses a
              partial hex and the whole style would then fail to save) simply ignores anything
              incomplete. `addRecentColour` does the same, so half-typed prefixes never reach the
              recents strip.
            */
            commit(e.target.value);
          }}
          style={{ width: '88px', fontFamily: 'var(--font-mono)' }}
        />
        {canPick && (
          <button
            type="button"
            aria-label={`Pick ${ariaLabel.toLowerCase()} from the screen`}
            title="Pick a colour from anywhere on screen"
            onClick={() => void runEyedropper()}
            style={{
              width: '28px',
              height: '28px',
              display: 'grid',
              placeItems: 'center',
              padding: 0,
              background: 'var(--surface-card)',
              border: '1px solid var(--line-default)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            <Pipette size={14} />
          </button>
        )}
        <div style={{ display: 'inline-flex', gap: 'var(--space-1)' }}>
          {DEFAULT_SWATCHES.map((sw, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Select preset swatch ${i + 1}`}
              onClick={() => commit(sw)}
              style={{
                width: '18px',
                height: '18px',
                borderRadius: 'var(--radius-xs)',
                border: '1px solid var(--line-default)',
                background: sw,
                cursor: 'pointer',
              }}
            />
          ))}
        </div>
      </div>
      {recents.length > 0 && (
        <div style={{ display: 'inline-flex', gap: 'var(--space-1)' }} aria-label="Recent colours">
          {recents.map((hex) => (
            <button
              key={hex}
              type="button"
              aria-label={`Use recent colour ${hex}`}
              title={hex}
              onClick={() => commit(hex)}
              style={{
                width: '16px',
                height: '16px',
                borderRadius: 'var(--radius-xs)',
                border: '1px solid var(--line-default)',
                background: hex,
                cursor: 'pointer',
              }}
            />
          ))}
        </div>
      )}
      {notice && (
        <span role="status" style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>
          {notice}
        </span>
      )}
    </div>
  );
};

export interface TimecodeFieldProps {
  valueText: string;
  totalDurationText?: string;
  onCommit: (input: string) => boolean;
  ariaLabel?: string;
}

export const TimecodeField: React.FC<TimecodeFieldProps> = ({
  valueText,
  totalDurationText,
  onCommit,
  ariaLabel = 'Current timecode',
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(valueText);
  const [invalidPulse, setInvalidPulse] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(valueText);
  }, [valueText, editing]);

  const handleCommit = () => {
    const ok = onCommit(draft);
    if (!ok) {
      setInvalidPulse(true);
      setTimeout(() => setInvalidPulse(false), 240);
      setDraft(valueText);
    }
    setEditing(false);
  };

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
      {editing ? (
        <input
          type="text"
          aria-label={ariaLabel}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCommit();
            if (e.key === 'Escape') {
              setDraft(valueText);
              setEditing(false);
            }
          }}
          style={{
            width: '104px',
            height: '28px',
            padding: '0 var(--space-2)',
            background: 'var(--surface-card)',
            border: '1px solid var(--brand)',
            borderRadius: 'var(--radius-xs)',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-xs)',
          }}
        />
      ) : (
        <button
          type="button"
          aria-label={ariaLabel}
          onClick={() => setEditing(true)}
          onKeyDown={(e) => {
            if (e.key === 'F2') setEditing(true);
          }}
          style={{
            height: '28px',
            padding: '0 var(--space-2)',
            background: 'var(--surface-card)',
            border: `1px solid ${invalidPulse ? 'var(--error)' : 'var(--line-default)'}`,
            borderRadius: 'var(--radius-xs)',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-xs)',
            cursor: 'pointer',
          }}
        >
          {valueText}
        </button>
      )}
      {totalDurationText && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-xs)',
            color: 'var(--text-muted)',
          }}
        >
          / {totalDurationText}
        </span>
      )}
    </div>
  );
};

export const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: '20px',
      height: '20px',
      padding: '0 6px',
      background: 'var(--surface-pressed)',
      border: '1px solid var(--line-default)',
      borderRadius: 'var(--radius-xs)',
      color: 'var(--text-secondary)',
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--fs-xs)',
    }}
  >
    {children}
  </kbd>
);
