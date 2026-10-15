/**
 * Per-kind parameter tables surfaced through the media tool's `action=list`.
 *
 * The tool schema in the OpenClaw extension describes every parameter, but it is
 * a union over both kinds and says nothing about which parameters a given kind
 * actually accepts. Several schema descriptions even point at `action=list` for
 * the valid ranges ("Valid values depend on model; use action=list to check"),
 * so this table is what makes those promises true.
 *
 * The tables are keyed by kind rather than by model: a per-model table would need
 * a new settings field before the common case is covered, and the same kind
 * behaves the same way across providers unless the user says otherwise in
 * `capabilities`.
 */
import {
  MediaProviderKind,
  type MediaProviderKind as MediaProviderKindType,
} from '../../../shared/cowork/mediaProviders';

export interface MediaParameterDoc {
  /** JSON-ish type name, kept loose because `providerOptions` is free-form. */
  type: string;
  required?: boolean;
  description: string;
  example?: string | number | boolean;
}

export type MediaParameterSpec = Record<string, MediaParameterDoc>;

const REFERENCE_HINT = 'Absolute file path, URL, or data URL. When a media reference mapping is supplied, pass the mapped value, never a literal @ token.';

export const IMAGE_PARAMETER_SPEC: MediaParameterSpec = {
  prompt: {
    type: 'string',
    required: true,
    description: 'Text prompt describing the image to generate.',
  },
  model: {
    type: 'string',
    description: 'Model ID. Must be one of the models listed by action=list.',
  },
  image: {
    type: 'string',
    description: `Single reference image for image-to-image generation. ${REFERENCE_HINT}`,
  },
  images: {
    type: 'string[]',
    description: `Multiple reference images. ${REFERENCE_HINT}`,
  },
  size: {
    type: 'string',
    description: 'Output size, e.g. "1024x1024".',
    example: '1024x1024',
  },
  imageSize: {
    type: 'string',
    description: 'Image size for models that use imageConfig, e.g. "1K", "2K".',
    example: '2K',
  },
  aspectRatio: {
    type: 'string',
    description: 'Aspect ratio. Accepted values depend on the model.',
    example: '1:1',
  },
  resolution: {
    type: 'string',
    description: 'Resolution: "1K", "2K", "4K". Accepted values depend on the model.',
    example: '2K',
  },
  n: {
    type: 'number',
    description: 'Number of images to generate. Alias of count for models that use n.',
    example: 1,
  },
  count: {
    type: 'number',
    description: 'Number of images to generate.',
    example: 1,
  },
  quality: {
    type: 'string',
    description: 'Output quality, e.g. "low", "medium", "high", "auto".',
    example: 'high',
  },
  outputFormat: {
    type: 'string',
    description: 'Output image format.',
    example: 'png',
  },
  temperature: {
    type: 'number',
    description: 'Sampling temperature, for models that support it.',
    example: 1,
  },
  filename: {
    type: 'string',
    description: 'Suggested filename for the saved image.',
  },
  providerOptions: {
    type: 'object',
    description: 'Model-specific options passed through to the provider unchanged.',
  },
};

export const VIDEO_PARAMETER_SPEC: MediaParameterSpec = {
  prompt: {
    type: 'string',
    required: true,
    description: 'Text prompt describing the video to generate. Chinese and English both supported.',
  },
  model: {
    type: 'string',
    description: 'Model ID. Must be one of the models listed by action=list.',
  },
  image: {
    type: 'string',
    description: `Single reference image, e.g. the first frame for image-to-video. ${REFERENCE_HINT}`,
  },
  images: {
    type: 'string[]',
    description: `Multiple reference images; pair with imageRoles to give each one a role. ${REFERENCE_HINT}`,
  },
  imageRoles: {
    type: 'string[]',
    description: 'Role per image: "first_frame", "last_frame", "reference_image". Length must match images.',
  },
  firstFrame: {
    type: 'string',
    description: `First-frame image for image-to-video models. ${REFERENCE_HINT}`,
  },
  lastFrame: {
    type: 'string',
    description: `Last-frame image for first/last-frame video models. ${REFERENCE_HINT}`,
  },
  referenceImages: {
    type: 'string[]',
    description: `Reference images for reference-to-video models. ${REFERENCE_HINT}`,
  },
  video: {
    type: 'string',
    description: `Single reference video for video-to-video generation. ${REFERENCE_HINT}`,
  },
  videos: {
    type: 'string[]',
    description: `Multiple reference videos; pair with videoRoles. ${REFERENCE_HINT}`,
  },
  videoRoles: {
    type: 'string[]',
    description: 'Role per video: "reference_video". Length must match videos.',
  },
  durationSeconds: {
    type: 'number',
    description: 'Video duration in seconds. Valid range depends on the model; use -1 for automatic.',
    example: 5,
  },
  aspectRatio: {
    type: 'string',
    description: 'Aspect ratio. Accepted values depend on the model.',
    example: '16:9',
  },
  resolution: {
    type: 'string',
    description: 'Resolution: "480p", "720p", "1080p". Accepted values depend on the model.',
    example: '1080p',
  },
  audio: {
    type: 'boolean',
    description: 'Generate synchronized audio (speech, effects, music). Not supported by every model.',
    example: true,
  },
  watermark: {
    type: 'boolean',
    description: 'Include a watermark.',
    example: false,
  },
  cameraFixed: {
    type: 'boolean',
    description: 'Lock the camera position (no movement). Not supported by every model.',
    example: false,
  },
  returnLastFrame: {
    type: 'boolean',
    description: 'Also return the last frame as a PNG, for continuous sequences.',
    example: false,
  },
  seed: {
    type: 'number',
    description: 'Random seed for reproducibility; -1 for random.',
    example: -1,
  },
  filename: {
    type: 'string',
    description: 'Suggested filename for the saved video.',
  },
  providerOptions: {
    type: 'object',
    description: 'Model-specific options passed through to the provider unchanged.',
  },
};

/** The table for one kind, as attached to every model that kind returns. */
export const mediaParameterSpecFor = (kind: MediaProviderKindType): MediaParameterSpec => (
  kind === MediaProviderKind.Video ? VIDEO_PARAMETER_SPEC : IMAGE_PARAMETER_SPEC
);

/**
 * Renders a table as a compact bullet list rather than raw JSON: the table is
 * read by a model, and `- name (type): what it does` costs far fewer tokens than
 * a pretty-printed object while staying just as unambiguous.
 */
export const formatMediaParameterSpec = (spec: MediaParameterSpec): string => Object.entries(spec)
  .map(([name, doc]) => {
    const type = doc.required ? `${doc.type}, required` : doc.type;
    const example = doc.example === undefined ? '' : ` Example: ${JSON.stringify(doc.example)}.`;
    return `- ${name} (${type}): ${doc.description}${example}`;
  })
  .join('\n');