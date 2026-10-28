/**
 * Home, when no conversation is open: a large Pew, then a grid of cards for
 * the last conversations (or, with none to show, one centred message: no
 * sessions yet, no agents, can't reach the computer). Tap one to open it. No composer
 * and no buttons: a new conversation is started from the menu, where its
 * project and agent are chosen first.
 *
 * A card shows its own state: one that needs you is outlined in the
 * attention colour with the question or approval as its line; one that is
 * working says so in its agent's colour. The cards come from
 * `homeDashboard.ts` (pure, tested); this only draws them.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import {
  runOnJS,
  useAnimatedReaction,
  useFrameCallback,
  useSharedValue,
  withDelay,
  withTiming,
  type FrameInfo,
} from "react-native-reanimated";
import { theme } from "../theme";
import { text } from "../appStyles";
import { lastActiveLabel } from "../ggState";
import { loadHomeCards, saveHomeCards } from "../preferences";
import {
  homeLayoutCards,
  homeMessage,
  type DashboardCard,
  type HomeDashboard as Dashboard,
  type HomeLink,
} from "../homeDashboard";
import { homeMood, pewInk } from "../pew/palette";
import { Pew } from "../pew/Pew";
import type { PewMood } from "../pew/engine";
import {
  homePewMood,
  homePewSize,
  nextLifeBeat,
  SPIN_AFTER,
  SPIN_LINE_MIN_MS,
  SPIN_STAGES,
  spinStage,
  type LifeBeat,
} from "../pew/homeLife";
import { PopFx } from "./LaunchFx";
import { haptics } from "./haptics";
import { sounds } from "./sounds";
import { useReducedMotion } from "./useReducedMotion";
import { useSystemReducedMotion } from "./accessibilityState";
import { useCalmMotion } from "./calmMotion";
import { Dissolve } from "./motion/Dissolve";
import { useAppActive } from "./useAppActive";
import { Led } from "./stage/Led";
import { PressScale } from "./stage/PressScale";
import { dashedOutline } from "./stage/DashedRule";

const CARD_HEIGHT = 104;
const ROW_GAP = theme.space(2);
/** The LED label and its gap to the grid. */
const LABEL_SPACE = 16 + theme.space(3);
/** Section gap, the bottom padding's extra and a little air above Pew. */
const CHROME = theme.space(6) + theme.space(4) + theme.space(4);
/** The label follows Pew by this much; the cards follow the label. */
const LABEL_AFTER_MS = 140;
/** Card text may grow only this far before the fixed height would clip it. */
const FONT_SCALE = 1.3;
/** The cards enter one after another, in reading order (left to right, top to bottom). */
const CARD_STAGGER_MS = 45;
/**
 * The line under Pew: one headline. Held whether or not anything is in it,
 * because Pew is centred on himself plus this line, and every change in its
 * height ("Can't reach your computer" giving way to "Spin me") moved him.
 */
const UNDER = text.headline.lineHeight ?? 28;
/** With no cards, the line can be a headline and a two-line note; hold all of it. */
const UNDER_CENTRED = UNDER + theme.space(1) + 2 * (text.subline.lineHeight ?? 19);

export interface HomeDashboardProps {
  home: Dashboard;
  link: HomeLink;
  /**
   * Called once Pew is placed and the screen has drawn a run of smooth frames,
   * which is when the native splash can dissolve into home and be seen to.
   */
  onFirstPaint?: () => void;
  /** The machine refused this phone (rotated key, version mismatch). */
  fatal?: string;
  /** Agents turned on and available; undefined while the list is unknown. */
  agents?: number;
  /** Pew's colour: the agent last used. */
  color?: string;
  /** False until the first wait is over: nothing below Pew is shown before it, so nothing arrives out of order. */
  settled: boolean;
  /**
   * The computer has actually answered with its agents and their sessions
   * (`State.heard`). Only then may home say there are none, or remember a
   * count for the next launch: "online" alone is just a socket that opened.
   */
  heard: boolean;
  top: number;
  bottom: number;
  onOpen: (id: string) => void;
  /** Tapping Pew: the agent switcher. */
  onPressPew?: () => void;
}

const FIRST_BEAT: LifeBeat = { mood: "idle", ms: 7000 };

function HomeDashboardView({
  home,
  link,
  onFirstPaint,
  fatal,
  agents,
  color,
  settled,
  heard,
  top,
  bottom,
  onOpen,
  onPressPew,
}: HomeDashboardProps) {
  const working = home.cards.some((card) => card.state === "working");
  // Asleep only once the computer is really out of reach, not while the socket
  // re-dials: that is every return to the app, and he dozed off and woke again
  // in the space of a second.
  const real: PewMood = fatal ? "oops" : homeMood(link !== "unreachable", working);
  const appActive = useAppActive();
  const { height } = useWindowDimensions();

  // Idle life: an excursion every 6-10 s, only while nothing real is showing.
  const [beat, setBeat] = useState<LifeBeat>(FIRST_BEAT);
  const [holding, setHolding] = useState(false);
  const lastTrip = useRef<PewMood | undefined>(undefined);
  const living = real === "idle" && appActive && !holding;
  useEffect(() => {
    if (!living) return;
    const timer = setTimeout(() => {
      const next = nextLifeBeat(beat.mood, lastTrip.current, Math.random());
      if (next.mood !== "idle") lastTrip.current = next.mood;
      setBeat(next);
    }, beat.ms);
    return () => clearTimeout(timer);
  }, [living, beat]);
  const onHold = useCallback((phase: "start" | "end") => {
    setHolding(phase === "start");
    // Let go: a short celebration, then back to idle life.
    if (phase === "end") setBeat({ mood: "celebrate", ms: 2200 });
  }, []);
  // The spin toy: the stage reached, the burst, and the moment after it.
  const spin = useSharedValue(0);
  const gone = useSharedValue(0);
  // `stage` is what the spin has reached (sounds, his face); `shownStage` is
  // the line under him, which holds each one SPIN_LINE_MIN_MS so a fast spin
  // still reads "Faster!" before "Nearly there!", never a flicker of both.
  const [stage, setStage] = useState(0);
  const [shownStage, setShownStage] = useState(0);
  const shownAt = useRef(0);
  useEffect(() => {
    if (shownStage === stage) return;
    const wait = Math.max(0, SPIN_LINE_MIN_MS - (Date.now() - shownAt.current));
    const t = setTimeout(() => {
      // One step at a time towards the spin, so every line is seen in order.
      setShownStage((current) => (stage > current ? current + 1 : stage));
      shownAt.current = Date.now();
    }, wait);
    return () => clearTimeout(t);
  }, [stage, shownStage]);
  const [popKey, setPopKey] = useState(0);
  const [after, setAfter] = useState(false);
  const reduceMotion = useReducedMotion();
  // The spin toy is the ball's, which stays in Calm; only the OS setting stops it.
  const systemReduced = useSystemReducedMotion();
  const stageRef = useRef(0);
  // The highest stage this spin-up has whirred for: a stage reached again
  // after a dip (it slowed for a moment) is quiet, so each whirrs once.
  const whirred = useRef(0);
  const onStage = useCallback((next: number) => {
    if (next === stageRef.current) return;
    // Up a stage: the top's whirr, faster each stage (its own sounds, not the
    // launch's). Down (it slowed): just the line.
    if (next > stageRef.current && next > whirred.current) {
      whirred.current = next;
      haptics.detent(null);
      sounds.play(`whirr-${Math.min(3, next)}` as "whirr-0");
    }
    // Spun right down: the next spin-up starts fresh.
    if (next === 0) whirred.current = 0;
    stageRef.current = next;
    setStage(next);
  }, []);
  // The stage reached, on the UI thread, with the margin that keeps a speed
  // sitting right at a threshold from flipping the stage back and forth.
  const reached = useSharedValue(0);
  useAnimatedReaction(
    () => {
      reached.value = spinStage(spin.value, reached.value);
      return reached.value;
    },
    (next, prev) => {
      if (next !== prev) runOnJS(onStage)(next);
    },
  );
  const onBurst = useCallback(() => {
    measureRef.current();
    haptics.attention(null);
    sounds.play("spin-pop");
    setTimeout(() => sounds.play("spin-sigh"), 1300);
    stageRef.current = 0;
    whirred.current = 0;
    setStage(0);
    setShownStage(0);
    shownAt.current = Date.now();
    setAfter(true);
    setPopKey((key) => key + 1);
    setBeat({ mood: SPIN_AFTER.mood, ms: SPIN_AFTER.ms });
  }, []);
  const popDone = useCallback(() => setPopKey(0), []);
  // He comes back once his dots have flown (gone eases back to 0), and the
  // line goes back to the invitation a moment after.
  useEffect(() => {
    if (!after) return;
    gone.value = withDelay(900, withTiming(0, { duration: 420 }));
    const t = setTimeout(() => setAfter(false), SPIN_AFTER.ms);
    return () => clearTimeout(t);
  }, [after, gone]);
  const toy = useMemo(() => ({ spin, gone, onBurst }), [spin, gone, onBurst]);
  // Loaded up front: a sound not yet loaded is skipped on its first play,
  // which left the first whirr and the burst silent.
  useEffect(() => {
    sounds.preload(["whirr-1", "whirr-2", "whirr-3", "spin-pop", "spin-sigh"]);
  }, []);
  // Where he is on screen, for the burst.
  const pewBox = useRef<View>(null);
  const [viewH, setViewH] = useState(0);
  const [contentH, setContentH] = useState(0);
  const [scene, setScene] = useState<
    { w: number; h: number; cx: number; cy: number; kenR: number } | undefined
  >(undefined);
  const { width } = useWindowDimensions();
  const measure = useCallback(() => {
    pewBox.current?.measureInWindow((x, y, w, h) =>
      setScene({ w: width, h: height, cx: x + w / 2, cy: y + h * 0.55, kenR: w * 0.36 }),
    );
  }, [width, height]);
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const spinMood = stage > 0 ? SPIN_STAGES[stage]!.mood : undefined;
  // Calm: the real state only, so the line rests unless something works.
  // The idle excursions kept it moving on Home for nothing (28 Oct).
  const calm = useCalmMotion();
  const mood = calm ? real : homePewMood(real, spinMood ?? beat.mood, holding);

  // The entrance clock: set once, when the data has settled, so the label and
  // every card take their slot from one moment in reading order, however late
  // a card mounts. A card arriving after that just fades in where it lands.
  const [introAt, setIntroAt] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (settled && introAt === undefined) setIntroAt(Date.now());
  }, [settled, introAt]);
  // Latched, not live: a reconnect reloads the list (`settled` drops back to
  // false while it does), and the cards and the line under Pew used to vanish
  // for that moment and fade back in. What was shown stays until it changes.
  const introduced = introAt !== undefined;
  const cards = introduced ? home.cards : [];
  // "No sessions yet" only from the computer's answer. Before it, an empty
  // list is just one that has not arrived, and claiming it showed the empty
  // state for a second on every launch over the relay.
  const message = introduced
    ? homeMessage({
        fatal,
        link,
        agents,
        empty: home.empty && heard,
        hasCards: cards.length > 0,
      })
    : undefined;
  // The toy's line, when home has nothing more important to say.
  // Not with reduced motion: there's no spin then, so no invitation to one.
  const toyLine =
    !message && introduced && real === "idle" && !reduceMotion
      ? after
        ? SPIN_AFTER.line
        : SPIN_STAGES[shownStage]!.line
      : undefined;
  // The layout is decided by what home WILL show, before the cards fade in:
  // with sessions (often known at once, from what this phone last saw) Pew
  // takes his place above their reserved space from the first frame; without
  // any yet, he waits until the list has settled. He never appears in one
  // place and then moves to another.
  // What home will show: the real count once the list has settled; before
  // that, the count it showed last time (remembered), so Pew's place is right
  // from the very first frame and never moves when the list arrives.
  const [remembered, setRemembered] = useState<number | undefined>(undefined);
  const [recalled, setRecalled] = useState(false);
  useEffect(() => {
    void loadHomeCards().then((count) => {
      setRemembered(count);
      setRecalled(true);
    });
  }, []);
  // Remembered only from the computer's own answer. `settled` was used here
  // and turns true as soon as the socket opens, before anything has arrived,
  // so an empty list was saved and the next launch laid out for none.
  useEffect(() => {
    if (heard) void saveHomeCards(home.cards.length);
  }, [heard, home.cards.length]);
  const willShow = homeLayoutCards({ known: home.cards.length, remembered });
  // Pew appears once his place is known, and only after the remembered count
  // has been read (a count read late would move him): from that count, or the
  // first time ever, from the answer itself, or, with no answer coming, from
  // what there is. And never before his colour is known: a first launch (right
  // after pairing) has no agent yet, and Pew used to appear grey and asleep,
  // then repaint in the agent's colour and wake when the list landed.
  const decided =
    recalled &&
    (heard || (settled && link !== "online") || (remembered !== undefined && color !== undefined));
  const centred = willShow === 0;
  const [painted, setPainted] = useState(false);
  const onPainted = useCallback(() => {
    setPainted(true);
    onFirstPaint?.();
  }, [onFirstPaint]);
  const rows = Math.ceil(willShow / 2);
  const sectionHeight = rows > 0 ? LABEL_SPACE + rows * CARD_HEIGHT + (rows - 1) * ROW_GAP : 0;
  // Sized for what home WILL show (the session count, known before the cards
  // are revealed), never re-sized when they arrive: a Pew re-sized in its
  // first moments was rebuilt mid-entrance and stayed blank.
  const pew = homePewSize({
    height,
    top,
    bottom: bottom + theme.space(4),
    // `willShow`, as the comment above says: sized from the cards loaded so
    // far, he was drawn for none and then shrunk when the list landed.
    cards: willShow,
    cardHeight: CARD_HEIGHT,
    rowGap: ROW_GAP,
    label: LABEL_SPACE,
    chrome: CHROME,
  });
  // What home has to say, when it says anything. Under Pew when there is no
  // card space; otherwise in the card space, where it takes up room that is
  // already held and so cannot move him (under him, its second line did).
  const messageView = message ? (
    <Dissolve kind="swap" dissolveKey={message.title} style={styles.message}>
      <Text style={text.headline} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
        {message.title}
      </Text>
      {message.line && (
        <Text style={text.subline} numberOfLines={2}>
          {message.line}
        </Text>
      )}
    </Dissolve>
  ) : null;
  return (
    <ScrollView
      // Only once the sessions overflow: otherwise there's nothing to scroll,
      // and a drag beside Pew moved the page instead of him.
      scrollEnabled={contentH > viewH + 1}
      onLayout={(e) => setViewH(e.nativeEvent.layout.height)}
      onContentSizeChange={(_w, h) => setContentH(h)}
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        { paddingTop: top, paddingBottom: bottom + theme.space(4) },
        centred && styles.centred,
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={[styles.hero, !centred && styles.heroFill]}>
        {decided ? (
          <Dissolve kind="in">
            <View ref={pewBox} onLayout={measure} collapsable={false}>
              <Pew
                size={pew}
                mood={mood}
                color={color}
                interactive
                onPress={onPressPew}
                onHold={onHold}
                toy={calm || systemReduced ? undefined : toy}
                // A near miss still grabs him, not the page.
                reach={Math.round(pew * 0.25)}
                accessibilityLabel={
                  onPressPew ? "Pew. Tap to switch agent, or spin him" : undefined
                }
              />
            </View>
          </Dissolve>
        ) : (
          // Holds Pew's box, so the space is the same before and after.
          <View style={{ width: pew, height: pew }} />
        )}
        {/* One slot for whatever is said under him, its height held from the
            first frame and through every swap, so Pew never moves for a line
            of text. Tucked up under his body: his box has room below it for
            the shadow. */}
        <View
          style={[
            styles.under,
            { minHeight: centred ? UNDER_CENTRED : UNDER, marginTop: -Math.round(pew * 0.12) },
          ]}
        >
          {toyLine ? (
            <Dissolve kind="swap" dissolveKey={toyLine} style={styles.message}>
              <Led
                tone={shownStage >= 3 || after ? "agent" : "dim"}
                color={shownStage >= 3 || after ? color : undefined}
              >
                {toyLine}
              </Led>
            </Dissolve>
          ) : message && centred ? (
            messageView
          ) : null}
        </View>
      </View>

      {decided && onFirstPaint && !painted ? <FirstPaint onPainted={onPainted} /> : null}

      {/* The burst: his dots across the whole screen, over everything. */}
      {popKey > 0 && scene && color ? (
        <Modal
          transparent
          visible
          animationType="none"
          statusBarTranslucent
          onRequestClose={popDone}
        >
          <PopFx key={popKey} scene={scene} color={color} onDone={popDone} />
        </Modal>
      ) : null}

      {/* The cards' space is held from the first frame they're known of, so
          their arrival never pushes Pew. */}
      {!centred && (
        <View style={[styles.section, { minHeight: sectionHeight }]}>
          {cards.length === 0 && messageView ? (
            <View style={styles.sectionMessage}>{messageView}</View>
          ) : null}
          {cards.length > 0 && (
            <>
              <Dissolve kind="row" startAt={(introAt ?? 0) + LABEL_AFTER_MS} lateSettled={false}>
                <Led tone="dim">Recent sessions</Led>
              </Dissolve>
              <View style={styles.grid}>
                {cards.map((card, i) => (
                  <Card
                    key={card.id}
                    card={card}
                    startAt={(introAt ?? 0) + LABEL_AFTER_MS + (i + 1) * CARD_STAGGER_MS}
                    onOpen={onOpen}
                  />
                ))}
              </View>
            </>
          )}
        </View>
      )}
    </ScrollView>
  );
}

export const HomeDashboard = memo(HomeDashboardView);

/** Consecutive on-time frames that count as "drawing smoothly again". */
const SMOOTH_FRAMES = 4;
/** Slower than this is a dropped frame at 60Hz, and restarts the count. */
const SMOOTH_FRAME_MS = 34;

/**
 * Reports once the screen is drawing on time again after home's first build.
 *
 * Counted on the UI thread, in frames, because the build freezes the screen
 * while JS timers keep running: a clock would say "ready" in the middle of the
 * freeze. Mounted only until it reports (mounting is how a frame callback
 * starts and stops here; see `PewTicker`).
 */
function FirstPaint({ onPainted }: { onPainted: () => void }) {
  const smooth = useSharedValue(0);
  const done = useSharedValue(false);
  const tick = useCallback(
    (info: FrameInfo) => {
      "worklet";
      if (done.value) return;
      const dt = info.timeSincePreviousFrame;
      smooth.value = dt !== null && dt < SMOOTH_FRAME_MS ? smooth.value + 1 : 0;
      if (smooth.value < SMOOTH_FRAMES) return;
      done.value = true;
      runOnJS(onPainted)();
    },
    [done, smooth, onPainted],
  );
  useFrameCallback(tick, true);
  return null;
}

function Card({
  card,
  startAt,
  onOpen,
}: {
  card: DashboardCard;
  startAt: number;
  onOpen: (id: string) => void;
}) {
  const ink = pewInk(card.color);
  const needs = card.state === "waiting";
  const where = card.project ?? card.agent ?? "";
  const when = needs
    ? "Needs you"
    : card.state === "working"
      ? "Working"
      : card.at
        ? lastActiveLabel(card.at)
        : "Earlier";
  return (
    <Dissolve kind="row" startAt={startAt} lateSettled={false} style={styles.cell}>
      <PressScale
        feel="tap"
        onPress={() => onOpen(card.id)}
        style={[styles.card, needs && styles.cardNeeds]}
        accessibilityLabel={`${needs ? "Needs you: " : card.state === "working" ? "Working: " : ""}${card.line ?? card.title}${where ? `, ${where}` : ""}`}
        accessibilityHint="Opens this conversation"
      >
        <View style={styles.cardHead}>
          <View style={[styles.dot, { backgroundColor: needs ? theme.color.attention : ink }]} />
          <Led
            tone={needs ? "attention" : card.state === "working" ? "agent" : "dim"}
            color={card.state === "working" ? ink : undefined}
            maxFontSizeMultiplier={FONT_SCALE}
            style={styles.flex}
            numberOfLines={1}
          >
            {when}
          </Led>
        </View>
        <Text style={styles.cardTitle} numberOfLines={2} maxFontSizeMultiplier={FONT_SCALE}>
          {card.line ?? card.title}
        </Text>
        <Led color={ink} unlit maxFontSizeMultiplier={FONT_SCALE} numberOfLines={1}>
          {where}
        </Led>
      </PressScale>
    </Dissolve>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignSelf: "stretch" },
  content: { flexGrow: 1, paddingHorizontal: theme.gutter, gap: theme.space(6) },
  centred: { flexGrow: 1, justifyContent: "center" },
  hero: { alignItems: "center", gap: theme.space(3) },
  // Pew takes the upper room; the cards sit at the bottom.
  heroFill: { flexGrow: 1, justifyContent: "center" },
  message: { alignItems: "center", gap: theme.space(1), alignSelf: "stretch" },
  under: { alignSelf: "stretch", alignItems: "center" },

  section: { gap: theme.space(3) },
  sectionMessage: { flexGrow: 1, justifyContent: "center", alignItems: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: ROW_GAP },
  // Two per row: half the width less half the gap.
  cell: { width: `48.6%` },
  card: {
    ...dashedOutline,
    height: CARD_HEIGHT,
    borderRadius: 12,
    padding: theme.space(3),
    gap: theme.space(1.5),
    justifyContent: "space-between",
  },
  cardNeeds: { borderStyle: "solid", borderColor: theme.color.attention },
  cardHead: { flexDirection: "row", alignItems: "center", gap: theme.space(1.5) },
  cardTitle: { flex: 1, color: theme.color.text, fontSize: 13, lineHeight: 17 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  flex: { flex: 1, minWidth: 0 },
});
