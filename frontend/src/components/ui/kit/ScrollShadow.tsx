import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'react-bootstrap-icons';
import './ScrollShadow.css';

type ScrollShadowProps = {
  children: ReactNode;
  /** Extra classes of the outer box (e.g. a margin). */
  className?: string;
  testId?: string;
};

type Edges = { start: boolean; end: boolean };

/** Below one pixel is rounding (zoomed or high-DPI screens), not content. */
const SLACK = 1;

const edgesOf = (element: HTMLElement): Edges => ({
  start: element.scrollLeft > SLACK,
  end: element.scrollLeft + element.clientWidth < element.scrollWidth - SLACK,
});

/**
 * A horizontal scroll box for content that may be wider than the screen (a
 * small hand-built pivot / summary table). While there is more content to a
 * side, that edge shows a permanent fade with a chevron - the scrollbar of a
 * phone is hidden until one scrolls, so without it nobody sees that the
 * table goes on. Content that fits shows no cue at all. Use it instead of
 * <Table responsive> (that wrapper would scroll inside this one); real data
 * tables belong in a DataTable with mobileColumns. Styles: ScrollShadow.css.
 */
const ScrollShadow = ({ children, className, testId }: ScrollShadowProps) => {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>({ start: false, end: false });

  const update = useCallback(() => {
    const element = scroller.current;
    if (!element) {
      return;
    }
    const next = edgesOf(element);
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, []);

  useEffect(() => {
    const element = scroller.current;
    if (!element) {
      return undefined;
    }
    update();
    // Width changes (rotation, panel resize, content loaded) move the edges too.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    if (element.firstElementChild) {
      observer?.observe(element.firstElementChild);
    }
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [update]);

  const classes = [
    'progeo-scroll-shadow',
    edges.start ? 'progeo-scroll-shadow--start' : '',
    edges.end ? 'progeo-scroll-shadow--end' : '',
    className ?? '',
  ];

  return (
    <div className={classes.filter(Boolean).join(' ')} data-testid={testId}>
      <div ref={scroller} className="progeo-scroll-shadow-scroller" onScroll={update}>
        {children}
      </div>
      <span className="progeo-scroll-shadow-edge progeo-scroll-shadow-edge--start" aria-hidden="true">
        <ChevronLeft size={12} />
      </span>
      <span className="progeo-scroll-shadow-edge progeo-scroll-shadow-edge--end" aria-hidden="true">
        <ChevronRight size={12} />
      </span>
    </div>
  );
};

export default ScrollShadow;
