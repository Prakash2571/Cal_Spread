/**
 * Compact on/off control for Box trade sounds, styled to sit among the existing Box
 * toolbar controls (mirrors ThemeToggle: `btn` + a size-16 Phosphor icon + a label).
 */

import { SpeakerHighIcon, SpeakerSlashIcon } from "@phosphor-icons/react";

interface BoxSoundToggleProps {
  enabled: boolean;
  onToggle: () => void;
}

export default function BoxSoundToggle({ enabled, onToggle }: BoxSoundToggleProps) {
  // The control announces its CURRENT state; the action is implied by the pressed state.
  const label = enabled ? "Box sounds enabled" : "Box sounds disabled";
  const actionLabel = enabled ? "Disable Box trade sounds" : "Enable Box trade sounds";

  return (
    <button
      type="button"
      className="btn box-sound-toggle"
      aria-label={actionLabel}
      aria-pressed={enabled}
      title={label}
      onClick={onToggle}
    >
      {enabled ? (
        <SpeakerHighIcon size={16} weight="regular" aria-hidden="true" />
      ) : (
        <SpeakerSlashIcon size={16} weight="regular" aria-hidden="true" />
      )}
      <span>Sounds</span>
    </button>
  );
}
