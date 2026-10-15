import React from 'react';

import {
  OPEN_SOURCE_LICENSE_URL,
  OPEN_SOURCE_REPO_URL,
} from '../../constants/openSource';
import { i18nService } from '../../services/i18n';

export const AboutOpenSourceAction = {
  OpenRepo: 'open_source_repo',
  OpenLicense: 'open_source_license',
} as const;
export type AboutOpenSourceAction = typeof AboutOpenSourceAction[keyof typeof AboutOpenSourceAction];

interface AboutOpenSourceProps {
  onAction: (action: AboutOpenSourceAction) => void;
}

const infoRowClassName = 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 border-b border-border';
const infoRowLinkClassName = 'min-w-0 break-all text-right text-sm text-secondary hover:text-primary dark:hover:text-primary bg-transparent border-none appearance-none px-1.5 py-0.5 -mx-1.5 -my-0.5 rounded-md cursor-pointer focus:outline-none hover:bg-surface-raised transition-colors';

const openExternalLink = (url: string): void => {
  void window.electron.shell.openExternal(url);
};

/** Info-card rows for the repository and license; rendered inside the About card. */
export const AboutOpenSourceRows: React.FC<AboutOpenSourceProps> = ({ onAction }) => (
  <>
    <div className={infoRowClassName}>
      <span className="shrink-0 text-sm text-foreground">{i18nService.t('aboutSourceCode')}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAction(AboutOpenSourceAction.OpenRepo);
          openExternalLink(OPEN_SOURCE_REPO_URL);
        }}
        className={infoRowLinkClassName}
      >
        {OPEN_SOURCE_REPO_URL}
      </button>
    </div>
    <div className={infoRowClassName}>
      <span className="shrink-0 text-sm text-foreground">{i18nService.t('aboutLicense')}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAction(AboutOpenSourceAction.OpenLicense);
          openExternalLink(OPEN_SOURCE_LICENSE_URL);
        }}
        className={infoRowLinkClassName}
      >
        {i18nService.t('aboutLicenseMit')}
      </button>
    </div>
  </>
);