/**
 * Store-bound dock controls. Each one subscribes to exactly one parameter, so dragging a slider
 * re-renders that row and nothing else. Live values go in with `commit: false`; the end of the
 * gesture (pointer up, Enter, key up) closes them into one undo entry.
 *
 *   <ParamSlider param="contrast" label="Contrast" tooltip={TIPS.contrast} />
 *   <ParamSwitch param="invert" label="Invert" tooltip={{ body: TIPS.invert, shortcut: 'I' }} tooltipOn="switch" />
 *   <LabelledRow label="Dither" tooltip={TIPS.ditherPattern}>{(id) => <Segmented labelledBy={id} … />}</LabelledRow>
 */
import { useId, useState, type ReactNode } from 'react';
import type { RenderParams } from '../../engine/types';
import { defaultParams, NUMERIC_SPECS, type NumericParamKey, type ParamKey } from '../../state/params';
import { useStore } from '../../state/store';
import { SliderRow, SwitchRow, TipLabel, useTip, type RowTooltip } from '../kit';

type BooleanParamKey = { [K in ParamKey]: RenderParams[K] extends boolean ? K : never }[ParamKey];

const DEFAULTS = defaultParams();

export const store = () => useStore.getState();

export function setLive<K extends ParamKey>(key: K, value: RenderParams[K]): void {
  store().setParam(key, value, { commit: false });
}

export function commitLive(): void {
  store().commitParams();
}

export function ParamSlider({ param, label, tooltip, disabled }: { param: NumericParamKey; label: string; tooltip?: RowTooltip; disabled?: boolean }) {
  const value = useStore((s) => s.params[param]);
  const defaultValue = DEFAULTS[param];
  const { min, max, step, bipolar, format } = NUMERIC_SPECS[param];
  return (
    <SliderRow
      label={label}
      tooltip={tooltip}
      value={value}
      min={min}
      max={max}
      step={step}
      bipolar={bipolar}
      format={format}
      defaultValue={defaultValue}
      disabled={disabled}
      onChange={(v) => setLive(param, v)}
      onCommit={commitLive}
    />
  );
}

export interface ParamSwitchProps {
  param: BooleanParamKey;
  label: string;
  sub?: ReactNode;
  tooltip?: RowTooltip;
  tooltipOn?: 'label' | 'switch';
}

export function ParamSwitch({ param, label, sub, tooltip, tooltipOn }: ParamSwitchProps) {
  const checked = useStore((s) => s.params[param]);
  return <SwitchRow label={label} sub={sub} tooltip={tooltip} tooltipOn={tooltipOn} checked={checked} onChange={(v) => store().setParam(param, v)} />;
}

/**
 * The 96 px label column of the slider rows, for a segmented control or select on the right. A
 * tooltip goes on the label (dotted indicator) and opens when the control has keyboard focus.
 */
export function LabelledRow({ label, tooltip, children }: { label: string; tooltip?: string; children(labelId: string): ReactNode }) {
  const id = useId();
  const tip = useTip(tooltip ? { body: tooltip } : null, { tap: true, describe: false });
  return (
    <div className="segrow" onFocus={tip.focus.onFocus} onBlur={tip.focus.onBlur}>
      <span id={id}>{tooltip ? <TipLabel tip={tip}>{label}</TipLabel> : label}</span>
      {children(id)}
      {tip.node}
    </div>
  );
}

// Open / closed state of the dock's disclosures outlives the panel (it unmounts while Export is open).
const remembered: Record<string, boolean> = {};

export function useRememberedOpen(id: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => remembered[id] ?? false);
  return [
    open,
    (next) => {
      remembered[id] = next;
      setOpen(next);
    },
  ];
}
