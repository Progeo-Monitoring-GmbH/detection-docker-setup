import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Form, Modal, Spinner } from 'react-bootstrap';
import {
  ArrowUpRight,
  BoundingBox,
  ChatLeftText,
  CheckCircle,
  CheckCircleFill,
  Download,
  ExclamationTriangle,
  Trash,
} from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import KeyHints, { announceKey } from '../components/ui/KeyHints';
import useIsMobile from '../components/ui/useIsMobile';
import {
  useKeyNavigation,
  useSwipeNavigation,
} from '../components/ui/useDirectionalNavigation';
import { staffFlags } from './access';
import { formatDate } from './dateFormat';
import StitchedScreenshot from './StitchedScreenshot';
import {
  ACTION_COLORS,
  NOTE_ACTIONS,
  SCREEN_REVIEW_URL,
  ALL_SCREENS,
  defaultAction,
  sliceHeightOf,
  slicesOf,
  filterImages,
  notesByImage,
  stepCursor,
  type CursorMove,
  type DraftShape,
  type NoteAction,
  type ReviewedMark,
  type ScreenDevice,
  type ScreenFilter,
  type ScreenImage,
  type ScreenLanguage,
  type ScreenNote,
  type ScreenRole,
  type ScreenRun,
} from './screenReview';
import './ScreenReviewView.css';

type RunDetail = {
  run: string;
  images: ScreenImage[];
  notes: ScreenNote[];
  reviewed?: ReviewedMark[];
};
type Tool = 'arrow' | 'area' | 'note';

/** Part height of the gallery's previews (px on screen). */
const PREVIEW_PART_HEIGHT = 200;

/**
 * The screenshot as an object URL (it needs the login's header) - fetched
 * once per run and file while `enabled`, kept in `cache` for the page's life.
 */
const useScreenshotSrc = (
  cache: Map<string, string>,
  run: string,
  file: string,
  enabled: boolean,
) => {
  const auth = useAuth();
  const key = `${run}/${file}`;
  const [loaded, setLoaded] = useState<{ key: string; src: string } | null>(
    null,
  );
  const cached = cache.get(key) ?? null;
  useEffect(() => {
    if (!enabled || cached) {
      return undefined;
    }
    let alive = true;
    void axiosConfig.perform_get(
      auth,
      `${SCREEN_REVIEW_URL}${run}/image/${file}/`,
      (response) => {
        const src = URL.createObjectURL(response.data as Blob);
        cache.set(key, src);
        if (alive) {
          setLoaded({ key, src });
        }
      },
      () => undefined,
      { responseType: 'blob' },
    );
    return () => {
      alive = false;
    };
    // Once per image - `auth` changes with the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, cached]);
  return cached ?? (loaded?.key === key ? loaded.src : null);
};

const ImageBadges = ({
  image,
  notes,
}: {
  image: ScreenImage;
  notes: number;
}) => {
  const { t } = useTranslation();
  return (
    <span className="screen-badges">
      <Badge bg="primary">{t(`screens_device_${image.device}`)}</Badge>
      <Badge bg="secondary">{t(`screens_role_${image.role}`)}</Badge>
      <Badge bg="light" text="dark">
        {image.language.toUpperCase()}
      </Badge>
      {notes > 0 && (
        <Badge bg="warning" text="dark">
          {t('screens_notes_count', { count: notes })}
        </Badge>
      )}
      {image.errors.length > 0 && (
        <Badge bg="danger" title={image.errors.join('\n')}>
          <ExclamationTriangle className="me-1" />
          {t('screens_page_errors')}
        </Badge>
      )}
    </span>
  );
};

/**
 * A screenshot of the gallery: its name, badges and parts - the part the
 * cursor is on framed (`activePart`, only on the active card).
 */
const ScreenCard = ({
  run,
  image,
  notes,
  cache,
  activePart,
  reviewed,
  onOpen,
  onSelectPart,
  onToggleReviewed,
}: {
  run: string;
  image: ScreenImage;
  notes: ScreenNote[];
  cache: Map<string, string>;
  activePart: number | null;
  reviewed: ReviewedMark | null;
  onOpen: () => void;
  onSelectPart: (part: number) => void;
  onToggleReviewed: () => void;
}) => {
  const { t } = useTranslation();
  // Every screenshot of the filter loads right away - moving on is instant.
  const src = useScreenshotSrc(cache, run, image.file, true);
  return (
    <div
      className={`screen-card${activePart != null ? ' screen-card--active' : ''}${reviewed ? ' screen-card--reviewed' : ''}`}
      data-testid="screen-card"
      data-test-key={image.file}
    >
      <div className="screen-card-head">
        <button
          type="button"
          className="screen-card-title"
          onClick={onOpen}
          data-testid="screen-card-open"
        >
          {image.action}
        </button>
        <span className="screen-card-path">{image.path}</span>
        <ImageBadges image={image} notes={notes.length} />
        <PillButton
          label={reviewed ? t('screens_reviewed') : t('screens_mark_reviewed')}
          title={
            reviewed
              ? t('screens_reviewed_by', {
                  name: reviewed.reviewed_by_name ?? '–',
                  date: formatDate(reviewed.created),
                })
              : t('screens_mark_reviewed_hint')
          }
          onClick={onToggleReviewed}
          active={Boolean(reviewed)}
          icon={reviewed ? <CheckCircleFill /> : <CheckCircle />}
          testId="screen-card-reviewed"
          testKey={image.file}
        />
        <PillButton
          label={t('screens_comment')}
          onClick={onOpen}
          icon={<ChatLeftText />}
          testId="screen-card-comment"
          testKey={image.file}
        />
      </div>
      {/* A click on a part puts the cursor there; a double click opens the screenshot for comments. */}
      <div
        className="screen-card-parts"
        onClick={(event) => {
          const part = (event.target as Element).closest<HTMLElement>(
            '[data-part-index]',
          );
          if (part) {
            onSelectPart(Number(part.dataset.partIndex));
          }
        }}
        onDoubleClick={onOpen}
        role="presentation"
      >
        <StitchedScreenshot
          src={src}
          image={image}
          partHeight={PREVIEW_PART_HEIGHT}
          notes={notes}
          activePart={activePart}
          testId="screen-card-parts"
        />
      </div>
    </div>
  );
};

/** The screenshot large, with the drawing tools and its comments. */
const ScreenEditor = ({
  run,
  image,
  notes,
  cache,
  onClose,
  onNotes,
}: {
  run: string;
  image: ScreenImage;
  notes: ScreenNote[];
  cache: Map<string, string>;
  onClose: () => void;
  onNotes: (update: (notes: ScreenNote[]) => ScreenNote[]) => void;
}) => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const src = useScreenshotSrc(cache, run, image.file, true);
  const [tool, setTool] = useState<Tool | null>(null);
  const [draft, setDraft] = useState<DraftShape | null>(null);
  // The form: a new shape (draft, done) or a note picked to change.
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [action, setAction] = useState<NoteAction>('select');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  // The parts' size: at most the window's height; at first only as tall as
  // lets two parts stand side by side (an arrow can run from one to the
  // next) - the size slider enlarges them.
  const windowHeight = () => Math.max(300, window.innerHeight - 190);
  const [maxPartHeight, setMaxPartHeight] = useState(windowHeight);
  const [partHeight, setPartHeight] = useState(() => {
    const width = Math.max(
      300,
      window.innerWidth - (window.innerWidth > 900 ? 420 : 48),
    );
    const twoParts = (((width - 16) / 2) * sliceHeightOf(image)) / image.width;
    return Math.round(Math.min(windowHeight(), Math.max(280, twoParts)));
  });
  useEffect(() => {
    const resize = () => {
      setMaxPartHeight(windowHeight());
      setPartHeight((current) => Math.min(current, windowHeight()));
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const resetForm = () => {
    setDraft(null);
    setFormOpen(false);
    setEditingId(null);
    setComment('');
  };

  const pickTool = (next: Tool) => {
    resetForm();
    if (next === 'note') {
      setTool(null);
      setDraft({ kind: 'note', geometry: null });
      setAction('select');
      setFormOpen(true);
      return;
    }
    setTool((current) => (current === next ? null : next));
  };

  const onDraft = (shape: DraftShape | null, done: boolean) => {
    setDraft(shape);
    if (done && shape) {
      setTool(null);
      setAction(defaultAction(shape.kind));
      setEditingId(null);
      setFormOpen(true);
    }
  };

  const editNote = (id: number) => {
    const note = notes.find((entry) => entry.id === id);
    if (!note) {
      return;
    }
    setTool(null);
    setDraft(null);
    setEditingId(id);
    setAction(note.action);
    setComment(note.comment);
    setFormOpen(true);
  };

  const save = () => {
    setBusy(true);
    const done = (response: { data: { note: ScreenNote } }) => {
      const saved = response.data.note;
      onNotes((current) =>
        editingId != null
          ? current.map((note) => (note.id === saved.id ? saved : note))
          : [...current, saved],
      );
      setBusy(false);
      resetForm();
    };
    const failed = (error: unknown) => {
      setBusy(false);
      showRequestError(enqueueSnackbar, t('screens_note_failed'), error);
    };
    if (editingId != null) {
      void axiosConfig.perform_patch(
        auth,
        `${SCREEN_REVIEW_URL}${run}/notes/${editingId}/`,
        { action, comment },
        done,
        failed,
      );
    } else if (draft) {
      void axiosConfig.perform_post(
        auth,
        `${SCREEN_REVIEW_URL}${run}/notes/`,
        {
          image: image.file,
          kind: draft.kind,
          geometry: draft.geometry,
          action,
          comment,
        },
        done,
        failed,
      );
    }
  };

  const remove = (id: number) => {
    axiosConfig.updateToken();
    void axiosConfig.holder
      .delete(`${SCREEN_REVIEW_URL}${run}/notes/${id}/`)
      .then(() => {
        onNotes((current) => current.filter((note) => note.id !== id));
        if (editingId === id) {
          resetForm();
        }
      })
      .catch((error: unknown) =>
        showRequestError(enqueueSnackbar, t('screens_note_failed'), error),
      );
  };

  return (
    <Modal show fullscreen onHide={onClose} data-testid="screen-editor">
      <Modal.Header closeButton>
        <Modal.Title className="screen-editor-title">
          {image.action}
          <span className="screen-card-path">{image.path}</span>
          <ImageBadges image={image} notes={notes.length} />
        </Modal.Title>
      </Modal.Header>
      <Modal.Body className="screen-editor">
        <div className="screen-editor-image">
          {!src && (
            <div className="screen-editor-loading">
              <Spinner animation="border" size="sm" />
            </div>
          )}
          <StitchedScreenshot
            src={src}
            image={image}
            partHeight={partHeight}
            notes={notes}
            selectedNoteId={editingId}
            onSelectNote={editNote}
            tool={tool === 'note' ? null : tool}
            draft={draft}
            onDraft={onDraft}
            testId="screen-editor-parts"
          />
        </div>
        <aside className="screen-editor-side">
          <div
            className="screen-editor-tools"
            role="group"
            aria-label={t('screens_tools')}
          >
            <PillButton
              label={t('screens_tool_arrow')}
              icon={<ArrowUpRight />}
              active={tool === 'arrow'}
              onClick={() => pickTool('arrow')}
              testId="screen-tool-arrow"
            />
            <PillButton
              label={t('screens_tool_area')}
              icon={<BoundingBox />}
              active={tool === 'area'}
              onClick={() => pickTool('area')}
              testId="screen-tool-area"
            />
            <PillButton
              label={t('screens_tool_note')}
              icon={<ChatLeftText />}
              active={draft?.kind === 'note'}
              onClick={() => pickTool('note')}
              testId="screen-tool-note"
            />
          </div>
          <Form.Group controlId="screen-editor-size">
            <Form.Label className="small mb-0">{t('screens_size')}</Form.Label>
            <Form.Range
              min={200}
              max={maxPartHeight}
              step={10}
              value={partHeight}
              onChange={(event) => setPartHeight(Number(event.target.value))}
              data-testid="screen-editor-size"
            />
          </Form.Group>
          {tool && (
            <div className="small text-muted">
              {t(`screens_tool_hint_${tool}`)}
            </div>
          )}

          {formOpen && (
            <div className="screen-note-form" data-testid="screen-note-form">
              <Form.Label className="small fw-semibold mb-1">
                {t('screens_action_label')}
              </Form.Label>
              <div className="screen-note-actions">
                {NOTE_ACTIONS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`screen-note-action${value === action ? ' screen-note-action--active' : ''}`}
                    style={{
                      borderColor: ACTION_COLORS[value],
                      ...(value === action
                        ? { backgroundColor: ACTION_COLORS[value] }
                        : {}),
                    }}
                    onClick={() => setAction(value)}
                    data-testid="screen-note-action"
                    data-test-key={value}
                  >
                    {t(`screens_action_${value}`)}
                  </button>
                ))}
              </div>
              <Form.Control
                as="textarea"
                rows={4}
                value={comment}
                maxLength={5000}
                placeholder={t('screens_comment_placeholder')}
                onChange={(event) => setComment(event.target.value)}
                autoFocus
                data-testid="screen-note-comment"
              />
              <div className="d-flex gap-2 justify-content-end">
                <Button
                  size="sm"
                  variant="outline-secondary"
                  onClick={resetForm}
                  disabled={busy}
                >
                  {t('screens_cancel')}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={save}
                  disabled={busy}
                  data-testid="screen-note-save"
                >
                  {busy && (
                    <Spinner size="sm" animation="border" className="me-1" />
                  )}
                  {t('screens_save')}
                </Button>
              </div>
            </div>
          )}

          <div className="screen-notes-title">{t('screens_notes_title')}</div>
          {notes.length === 0 ? (
            <div className="small text-muted">{t('screens_no_notes')}</div>
          ) : (
            <ol className="screen-notes" data-testid="screen-notes">
              {notes.map((note, index) => (
                <li
                  key={note.id}
                  className={`screen-note${note.id === editingId ? ' screen-note--selected' : ''}`}
                  data-testid="screen-note"
                  data-test-key={note.id}
                >
                  <button
                    type="button"
                    className="screen-note-body"
                    onClick={() => editNote(note.id)}
                  >
                    <span
                      className="screen-note-number"
                      style={{ backgroundColor: ACTION_COLORS[note.action] }}
                    >
                      {index + 1}
                    </span>
                    <span>
                      <strong>{t(`screens_action_${note.action}`)}</strong>
                      <span className="text-muted">
                        {' '}
                        · {t(`screens_kind_${note.kind}`)}
                      </span>
                      <span className="d-block">{note.comment || '–'}</span>
                      <span className="d-block small text-muted">
                        {note.author_name ?? '–'} · {formatDate(note.created)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="screen-note-delete"
                    onClick={() => remove(note.id)}
                    title={t('screens_delete_note')}
                    aria-label={t('screens_delete_note')}
                    data-testid="screen-note-delete"
                  >
                    <Trash />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </Modal.Body>
    </Modal>
  );
};

/**
 * /review/screens/ (staff): the screenshots of a build - every route, pc and
 * mobile, as a user and as staff (python manage.py e2e_screenshots) - cut
 * into numbered parts side by side. A screenshot opens for comments: an
 * arrow (move it there), an area or the whole screen, each with what to do.
 * "Export" gives a ZIP with the commented screenshots and a PROMPT.md.
 */
const ScreenReviewView = () => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const isSuperuser = staffFlags(auth?.user).isSuperuser;
  const [runs, setRuns] = useState<ScreenRun[] | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [filter, setFilter] = useState<ScreenFilter>(ALL_SCREENS);
  const setFilterPart = (part: Partial<ScreenFilter>) =>
    setFilter((current) => ({ ...current, ...part }));
  const [openFile, setOpenFile] = useState<string | null>(null);
  // The keyboard / swipe cursor: a screenshot (by file - it stays across
  // filter changes) and one of its parts.
  // `index`: where it stood - a screenshot that left the list (filtered,
  // hidden as reviewed) hands the cursor to the one now there.
  const [cursor, setCursor] = useState<{
    file: string | null;
    part: number;
    index: number;
  }>({
    file: null,
    part: 0,
    index: 0,
  });
  const touch = useIsMobile('(pointer: coarse)');
  const galleryRef = useRef<HTMLDivElement | null>(null);
  // Scrolled to after a move (keys, swipes) - not when the page just shows it.
  const scrollToCursor = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The object URLs of the loaded screenshots - freed when the page is left.
  const [cache] = useState(() => new Map<string, string>());
  useEffect(
    () => () => cache.forEach((src) => URL.revokeObjectURL(src)),
    [cache],
  );

  const loadRuns = () => {
    void axiosConfig.perform_get(
      auth,
      SCREEN_REVIEW_URL,
      (response) => {
        const loaded = (response?.data?.runs ?? []) as ScreenRun[];
        setRuns(loaded);
        setRunId((current) =>
          current && loaded.some((run) => run.run === current)
            ? current
            : (loaded[0]?.run ?? null),
        );
      },
      (error) => {
        setRuns([]);
        showRequestError(enqueueSnackbar, t('screens_load_failed'), error);
      },
    );
  };
  useEffect(() => {
    loadRuns();
    // Once - `auth` changes with the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!runId) {
      return undefined;
    }
    let alive = true;
    void axiosConfig.perform_get(
      auth,
      `${SCREEN_REVIEW_URL}${runId}/`,
      (response) => alive && setDetail(response?.data as RunDetail),
      (error) =>
        alive &&
        showRequestError(enqueueSnackbar, t('screens_load_failed'), error),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const shownDetail = detail?.run === runId ? detail : null;
  const notes = useMemo(
    () => notesByImage(shownDetail?.notes ?? []),
    [shownDetail],
  );
  const reviewedMarks = useMemo(
    () =>
      new Map((shownDetail?.reviewed ?? []).map((mark) => [mark.image, mark])),
    [shownDetail],
  );
  const images = useMemo(
    () =>
      filterImages(
        shownDetail?.images ?? [],
        filter,
        new Set(notes.keys()),
        new Set(reviewedMarks.keys()),
      ),
    [shownDetail, filter, notes, reviewedMarks],
  );
  const reviewedCount = (shownDetail?.images ?? []).filter((image) =>
    reviewedMarks.has(image.file),
  ).length;

  // The cursor's screenshot in the filtered list - gone from it: the one
  // now at its place, from its first part.
  const foundIndex = images.findIndex((image) => image.file === cursor.file);
  const cursorIndex =
    foundIndex >= 0
      ? foundIndex
      : Math.max(Math.min(cursor.index, images.length - 1), 0);
  const partsOf = (index: number) => {
    const image = images[index];
    return image ? slicesOf(image.height, sliceHeightOf(image)).length : 0;
  };
  const cursorPart =
    foundIndex >= 0
      ? Math.min(cursor.part, Math.max(partsOf(cursorIndex) - 1, 0))
      : 0;
  const currentImage = images[cursorIndex] ?? null;

  const move = (step: CursorMove, hint: string) => {
    if (!images.length) {
      return;
    }
    const next = stepCursor(
      { index: cursorIndex, part: cursorPart },
      step,
      images.length,
      partsOf,
    );
    scrollToCursor.current = true;
    setCursor({
      file: images[next.index].file,
      part: next.part,
      index: next.index,
    });
    announceKey(hint);
  };

  useEffect(() => {
    if (!scrollToCursor.current || !currentImage) {
      return;
    }
    scrollToCursor.current = false;
    const selector = `[data-testid="screen-card"][data-test-key="${CSS.escape(currentImage.file)}"] [data-part-index="${cursorPart}"]`;
    galleryRef.current?.querySelector(selector)?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  });

  const toggleReviewed = (file: string) => {
    if (!runId) {
      return;
    }
    const marking = !reviewedMarks.has(file);
    // Hidden once reviewed: the cursor goes on to the next screenshot.
    if (marking && filter.hideReviewed && currentImage?.file === file) {
      const neighbour =
        images[cursorIndex + 1] ?? images[cursorIndex - 1] ?? null;
      setCursor({ file: neighbour?.file ?? null, part: 0, index: cursorIndex });
    }
    void axiosConfig.perform_post(
      auth,
      `${SCREEN_REVIEW_URL}${runId}/reviewed/`,
      { image: file, reviewed: marking },
      (response) => {
        const mark = (response?.data?.reviewed ?? null) as ReviewedMark | null;
        setDetail((current) =>
          current
            ? {
                ...current,
                reviewed: [
                  ...(current.reviewed ?? []).filter(
                    (entry) => entry.image !== file,
                  ),
                  ...(mark ? [mark] : []),
                ],
              }
            : current,
        );
      },
      (error) =>
        showRequestError(enqueueSnackbar, t('screens_reviewed_failed'), error),
    );
  };

  // Keys on the page: parts and screenshots, "r" reviewed, Enter comments.
  useKeyNavigation(
    {
      left: () => move('previousPart', 'screens-part'),
      right: () => move('nextPart', 'screens-part'),
      up: () => move('previousScreen', 'screens-screen'),
      down: () => move('nextScreen', 'screens-screen'),
      keys: {
        r: () => {
          if (currentImage) {
            announceKey('screens-reviewed');
            toggleReviewed(currentImage.file);
          }
        },
        enter: () => currentImage && setOpenFile(currentImage.file),
      },
    },
    Boolean(shownDetail) && openFile === null && images.length > 0,
  );

  // Touch: a swipe across a screenshot's parts moves through them (from the
  // screenshot swiped on); up and down is the page's own scrolling.
  useSwipeNavigation(
    galleryRef,
    (direction, target) => {
      if (direction !== 'left' && direction !== 'right') {
        return;
      }
      const file = target?.closest<HTMLElement>('[data-testid="screen-card"]')
        ?.dataset.testKey;
      const index = images.findIndex((image) => image.file === file);
      if (index < 0) {
        return;
      }
      const from = { index, part: index === cursorIndex ? cursorPart : 0 };
      const next = stepCursor(
        from,
        direction === 'right' ? 'nextPart' : 'previousPart',
        images.length,
        partsOf,
      );
      scrollToCursor.current = true;
      setCursor({
        file: images[next.index].file,
        part: next.part,
        index: next.index,
      });
    },
    Boolean(shownDetail) && openFile === null,
  );
  const openImage =
    shownDetail?.images.find((image) => image.file === openFile) ?? null;
  const noteCount = shownDetail?.notes.length ?? 0;

  const updateNotes =
    (file: string) => (update: (notes: ScreenNote[]) => ScreenNote[]) =>
      setDetail((current) => {
        if (!current) {
          return current;
        }
        const others = current.notes.filter((note) => note.image !== file);
        return {
          ...current,
          notes: [
            ...others,
            ...update(current.notes.filter((note) => note.image === file)),
          ],
        };
      });

  const exportZip = () => {
    if (!runId) {
      return;
    }
    setExporting(true);
    void axiosConfig.perform_get(
      auth,
      `${SCREEN_REVIEW_URL}${runId}/export/`,
      (response) => {
        const url = URL.createObjectURL(response.data as Blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `screen-review-${runId}.zip`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
        setExporting(false);
      },
      (error) => {
        setExporting(false);
        showRequestError(enqueueSnackbar, t('screens_export_failed'), error);
      },
      { responseType: 'blob' },
    );
  };

  const deleteRun = () => {
    if (!runId) {
      return;
    }
    axiosConfig.updateToken();
    void axiosConfig.holder
      .delete(`${SCREEN_REVIEW_URL}${runId}/`)
      .then(() => {
        setConfirmDelete(false);
        setRunId(null);
        setDetail(null);
        loadRuns();
      })
      .catch((error: unknown) =>
        showRequestError(enqueueSnackbar, t('screens_delete_failed'), error),
      );
  };

  return (
    <div className="screen-review" data-testid="page-screen-review">
      <PanelCard
        title={t('screens_title')}
        actions={
          runId && (
            <div className="d-flex gap-2 flex-wrap">
              <PillButton
                label={t('screens_export', { count: noteCount })}
                icon={
                  exporting ? (
                    <Spinner animation="border" size="sm" />
                  ) : (
                    <Download />
                  )
                }
                onClick={exportZip}
                disabled={exporting || noteCount === 0}
                testId="screens-export"
              />
              {isSuperuser && (
                <PillButton
                  label={t('screens_delete_run')}
                  icon={<Trash />}
                  onClick={() => setConfirmDelete(true)}
                  testId="screens-delete-run"
                />
              )}
            </div>
          )
        }
        testId="screens-panel"
      >
        <div className="small text-muted mb-3">{t('screens_intro')}</div>
        {runs === null ? (
          <Spinner animation="border" size="sm" />
        ) : runs.length === 0 ? (
          <div className="text-muted" data-testid="screens-no-runs">
            {t('screens_no_runs')}
          </div>
        ) : (
          <div className="screen-review-filters">
            <Form.Select
              size="sm"
              className="screen-review-run"
              value={runId ?? ''}
              onChange={(event) => setRunId(event.target.value)}
              aria-label={t('screens_run')}
              data-testid="screens-run"
            >
              {runs.map((run) => (
                <option key={run.run} value={run.run}>
                  {formatDate(run.created)} ·{' '}
                  {t('screens_count', { count: run.images })} ·{' '}
                  {t('screens_notes_count', { count: run.notes })}
                </option>
              ))}
            </Form.Select>
            <SegmentedControl
              testId="screens-device"
              options={[
                { value: 'all', label: t('screens_device_all') },
                { value: 'pc', label: t('screens_device_pc') },
                { value: 'mobile', label: t('screens_device_mobile') },
              ]}
              value={filter.device}
              onChange={(value) =>
                setFilterPart({ device: value as ScreenDevice | 'all' })
              }
            />
            <SegmentedControl
              testId="screens-role"
              options={[
                { value: 'all', label: t('screens_role_all') },
                { value: 'user', label: t('screens_role_user') },
                { value: 'staff', label: t('screens_role_staff') },
              ]}
              value={filter.role}
              onChange={(value) =>
                setFilterPart({ role: value as ScreenRole | 'all' })
              }
            />
            <SegmentedControl
              testId="screens-language"
              options={[
                { value: 'all', label: t('screens_language_all') },
                { value: 'de', label: 'DE' },
                { value: 'en', label: 'EN' },
              ]}
              value={filter.language}
              onChange={(value) =>
                setFilterPart({ language: value as ScreenLanguage | 'all' })
              }
            />
            <Form.Check
              type="switch"
              id="screens-commented-only"
              label={t('screens_commented_only')}
              checked={filter.commentedOnly}
              onChange={(event) =>
                setFilterPart({ commentedOnly: event.target.checked })
              }
              data-testid="screens-commented-only"
            />
            <Form.Check
              type="switch"
              id="screens-hide-reviewed"
              label={t('screens_hide_reviewed')}
              checked={filter.hideReviewed}
              onChange={(event) =>
                setFilterPart({ hideReviewed: event.target.checked })
              }
              data-testid="screens-hide-reviewed"
            />
            <span className="small text-muted" data-testid="screens-count">
              {t('screens_count', { count: images.length })} ·{' '}
              {t('screens_reviewed_count', {
                count: reviewedCount,
                total: shownDetail?.images.length ?? 0,
              })}
            </span>
          </div>
        )}
        {shownDetail && images.length > 0 && (
          <div className="screen-review-hints" data-testid="screens-hints">
            {touch ? (
              <span className="small text-muted">
                {t('screens_swipe_hint')}
              </span>
            ) : (
              <KeyHints
                title={t('screens_keys_title')}
                hints={[
                  {
                    id: 'screens-part',
                    keys: ['←/→'],
                    label: t('screens_key_parts'),
                  },
                  {
                    id: 'screens-screen',
                    keys: ['↑/↓'],
                    label: t('screens_key_screens'),
                  },
                  {
                    id: 'screens-reviewed',
                    keys: ['R'],
                    label: t('screens_key_reviewed'),
                  },
                  { keys: ['Enter'], label: t('screens_key_open') },
                ]}
              />
            )}
          </div>
        )}
      </PanelCard>

      {runId && !shownDetail && (
        <div className="text-center py-4">
          <Spinner animation="border" size="sm" />
        </div>
      )}
      {shownDetail && images.length === 0 && (
        <div className="text-muted text-center py-4">
          {t('screens_empty_filter')}
        </div>
      )}
      {shownDetail && (
        <div
          ref={galleryRef}
          className="screen-gallery"
          data-testid="screens-gallery"
        >
          {images.map((image, index) => (
            <ScreenCard
              key={image.file}
              run={shownDetail.run}
              image={image}
              notes={notes.get(image.file) ?? []}
              cache={cache}
              activePart={index === cursorIndex ? cursorPart : null}
              reviewed={reviewedMarks.get(image.file) ?? null}
              onOpen={() => setOpenFile(image.file)}
              onSelectPart={(part) =>
                setCursor({ file: image.file, part, index })
              }
              onToggleReviewed={() => toggleReviewed(image.file)}
            />
          ))}
        </div>
      )}

      {shownDetail && openImage && (
        <ScreenEditor
          run={shownDetail.run}
          image={openImage}
          notes={notes.get(openImage.file) ?? []}
          cache={cache}
          onClose={() => setOpenFile(null)}
          onNotes={updateNotes(openImage.file)}
        />
      )}

      <ConfirmDialog
        show={confirmDelete}
        title={t('screens_delete_run')}
        message={t('screens_delete_confirm', { run: runId ?? '' })}
        confirmLabel={t('screens_delete_run')}
        cancelLabel={t('screens_cancel')}
        onConfirm={deleteRun}
        onCancel={() => setConfirmDelete(false)}
        testId="screens-delete-confirm"
      />
    </div>
  );
};

export default ScreenReviewView;
