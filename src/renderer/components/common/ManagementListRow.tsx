import React from 'react';

import { MANAGEMENT_BODY_TEXT, MANAGEMENT_TITLE_TEXT } from './managementTypography';

/** Shared single-column list container for the management pages. */
export const MANAGEMENT_LIST_CONTAINER_CLASS =
  'divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface';

interface ManagementListRowProps {
  /** Left icon tile. */
  icon?: React.ReactNode;
  /** Row title (the entry name). Truncated to one line. */
  title: React.ReactNode;
  /** Extra classes for the title span, e.g. a muted color for disabled rows. */
  titleClassName?: string;
  /** Small badges rendered inline after the title. */
  badges?: React.ReactNode;
  /** Second line — one-line meta/description, truncated. */
  subtitle?: React.ReactNode;
  /** Right side: meta extras (date/count) then action buttons/menu. */
  right?: React.ReactNode;
  /** Opens the entry; the row becomes a button when provided. */
  onClick?: () => void;
  className?: string;
}

/**
 * One entry in a management list (Kits / Skills / MCP / Tasks) — the row form
 * of the former card grid. Uniform horizontal shape: icon, name with badges,
 * a one-line subtitle, and the actions pinned to the right. Used inside
 * `MANAGEMENT_LIST_CONTAINER_CLASS` so rows read as one list.
 */
const ManagementListRow: React.FC<ManagementListRowProps> = ({
  icon,
  title,
  titleClassName = '',
  badges,
  subtitle,
  right,
  onClick,
  className = '',
}) => {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onClick) return;
    // Nested controls (toggle, menu, pills) handle their own keys.
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? handleKeyDown : undefined}
      className={`group flex items-center gap-3 px-4 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${
        onClick ? 'cursor-pointer hover:bg-surface-raised/50' : ''
      } ${className}`}
    >
      {icon && <div className="shrink-0">{icon}</div>}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={`min-w-0 truncate ${MANAGEMENT_TITLE_TEXT} font-semibold leading-snug text-foreground ${titleClassName}`}
          >
            {title}
          </span>
          {badges && <span className="flex flex-shrink-0 items-center gap-1">{badges}</span>}
        </div>
        {subtitle && (
          <div className={`mt-0.5 truncate ${MANAGEMENT_BODY_TEXT} leading-5 text-secondary`}>
            {subtitle}
          </div>
        )}
      </div>
      {right && <div className="flex flex-shrink-0 items-center gap-1.5">{right}</div>}
    </div>
  );
};

export default ManagementListRow;
