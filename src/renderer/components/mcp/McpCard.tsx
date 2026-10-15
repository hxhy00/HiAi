import React from 'react';

import ManagementListRow from '../common/ManagementListRow';

interface McpCardProps {
  title: string;
  /** One-line meta summary; long descriptions live in the detail dialog. */
  description: string;
  /** Badges rendered inline after the title. */
  badges?: React.ReactNode;
  /** Capsule / overflow menu / toggle rendered on the right. */
  actions?: React.ReactNode;
  /** Opens the detail dialog; the row becomes a button when provided. */
  onOpenDetail?: () => void;
}

/**
 * One MCP entry in a management list — same row shape as a skill or task row,
 * so the management pages read as one product: single-line title with its
 * state badges, a one-line description, and the facts/actions pinned to the
 * right. No icon tile — the name is the thing you read first.
 */
const McpCard: React.FC<McpCardProps> = ({
  title,
  description,
  badges,
  actions,
  onOpenDetail,
}) => (
  <ManagementListRow
    title={title}
    badges={badges}
    subtitle={description}
    right={actions}
    onClick={onOpenDetail}
  />
);

export default McpCard;
