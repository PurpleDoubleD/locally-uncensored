/**
 * The base components of the mobile shell (DESIGN.md section 8).
 *
 * Every component brings its role, its name and its focus behaviour. A screen
 * cannot build a target without a name, because `label` is required where the
 * visible text is not a name. Every component takes `testid` (data-testid,
 * convention m-<screen>-<element>) and `el` (the element number from
 * DESIGN.md, written as data-el).
 *
 * There is no ConfirmHold on purpose: anything destructive goes through
 * nav.confirm, never through "tap twice".
 *
 * Not in this file, on purpose: the Markdown of an answer. It brings the
 * Markdown parser and the formula styles, which a settings page must not
 * load. Import it from its own file:
 *
 *   import { Markdown } from '../../ui/Markdown'
 *   import { answerText, fencedBlocks, findPreviewBlock } from '../../ui/markdown-blocks'
 */
export { Page, RootPage, PageChromeContext, type PageProps, type RootPageProps, type PageChrome } from './Page'
export { TabBar, TAB_ITEMS, tabName, type TabBadge } from './TabBar'
export { Sheet, type SheetProps } from './Sheet'
export { Dialog } from './Dialog'
export { toast, ToastHost, useToastStore, toastDuration, type ToastSpec } from './Toast'
export { List, ListGroup, Row, Card, Tag, BetaTag, type RowProps, type ListGroupProps } from './List'
export { Switch, SwitchTrack, type SwitchProps } from './Switch'
export { Segmented, type SegmentOption, type SegmentedProps } from './Segmented'
export { Chip, ChipGroup, type ChipProps } from './Chip'
export { Fold, type FoldProps } from './Fold'
export { PermissionRow, PERMISSION_LEVELS, type PermissionRowProps } from './PermissionRow'
export { Button, type ButtonProps, type ButtonVariant } from './Button'
export { IconButton, iconButtonName, type IconButtonProps } from './IconButton'
export { Field, TextArea, type FieldProps, type TextAreaProps } from './Field'
export { SecretField, type SecretFieldProps } from './SecretField'
export { Slider, NumberField, stepValue, parseNumberInput, type NumberProps, type NumberFieldProps } from './Slider'
export { Progress, Spinner, type ProgressProps } from './Progress'
export { Notice, ErrorState, Banner, OfflineIcon, type NoticeProps, type BannerProps, type BannerAction } from './Notice'
export { EmptyState, type EmptyStateProps } from './EmptyState'
export { Skeleton, SkeletonRows, SkeletonCards } from './Skeleton'
export { FitBadge, FIT_TEXT, type FitLevel } from './FitBadge'
export { ModelChip, modelChipName, type ModelChipProps } from './ModelChip'
export { Composer, ComposerTuneButton, composerSlot, micHoldHandlers, tuneSummary, type ComposerAttach, type ComposerMicHold, type ComposerProps, type ComposerTune } from './Composer'
export { MediaViewer, type MediaViewerProps } from './MediaViewer'
export { MiddleEllipsis, splitMiddle, type MiddleEllipsisProps } from './MiddleEllipsis'
export { Block, Hint, Heading, Sparse, Strip, type BlockProps, type StripProps } from './Layout'
export { useScreenShape, screenShape, type ScreenShape } from './screen-shape'
export { Icon, Monogram, type IconType } from './Icon'
export { ScreenPlaceholder, SheetPlaceholder } from './Placeholder'
export { cx, testProps, riskProps, RISKS, type Testable, type Risk, type RiskMarked } from './common'
export { caretToEnd } from './focus'
