import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	matchesKey,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	displayOptions,
	hasAnswer,
	hasMultiAnswer,
	newQuestionState,
	nextQuestion,
	orderedAnswers,
	previousQuestion,
	submitIfComplete,
} from "./state.ts";
import type { DialogResult, DisplayOption, InputMode, Question, QuestionOption } from "./types.ts";

export function createQuestionDialog(questions: Question[]) {
	return (tui: TUI, theme: Theme, _kb: unknown, done: (result: DialogResult) => void) => {
		let currentIdx = 0;
		let inputMode: InputMode;
		let noteTarget: string | undefined;
		let dialogFocused = false;
		let cachedLines: string[] | undefined;
		let cachedWidth: number | undefined;
		const states = questions.map(() => newQuestionState());

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		const currentQuestion = () => questions[currentIdx];
		const currentState = () => states[currentIdx];

		function refresh(): void {
			cachedLines = undefined;
			tui.requestRender();
		}

		function syncEditorFocus(): void {
			editor.focused = dialogFocused && inputMode !== undefined;
		}

		function setCurrentIdx(index: number): void {
			currentIdx = index;
			inputMode = undefined;
			noteTarget = undefined;
			editor.setText("");
			syncEditorFocus();
			refresh();
		}

		function clearWarning(): void {
			currentState().warning = undefined;
		}

		function focusedOption(): DisplayOption | undefined {
			return displayOptions(currentQuestion())[currentState().optionIndex];
		}

		function beginCustomInput(): void {
			const state = currentState();
			inputMode = "custom";
			noteTarget = undefined;
			const existingSingle = state.singleAnswer?.kind === "custom" ? state.singleAnswer.answer : undefined;
			editor.setText(state.customAnswer?.text ?? existingSingle ?? "");
			syncEditorFocus();
			refresh();
		}

		function selectSingleOption(option: QuestionOption): void {
			const question = currentQuestion();
			const state = currentState();
			state.singleAnswer = {
				questionIndex: currentIdx,
				question: question.question,
				header: question.header,
				kind: "option",
				answer: option.label,
				...(option.preview ? { preview: option.preview } : {}),
			};
			state.warning = undefined;
		}

		function beginNotesInput(): void {
			const question = currentQuestion();
			const state = currentState();
			const option = focusedOption();
			if (!option || option.kind === "other") {
				beginCustomInput();
				return;
			}
			if (question.multiSelect && !state.multiSelected.has(option.optionIndex)) {
				state.warning = "Select the option first, then press Tab to add notes.";
				refresh();
				return;
			}
			if (!question.multiSelect) selectSingleOption(option);
			inputMode = "notes";
			noteTarget = option.label;
			editor.setText(state.notesByOption.get(option.label) ?? "");
			syncEditorFocus();
			refresh();
		}

		function recordSingle(option: DisplayOption): void {
			if (option.kind === "other") {
				if (currentState().singleAnswer?.kind === "custom") {
					submitIfComplete(done, questions, states, currentIdx);
					refresh();
					return;
				}
				beginCustomInput();
				return;
			}
			selectSingleOption(option);
			submitIfComplete(done, questions, states, currentIdx);
			refresh();
		}

		function recordMulti(): void {
			const state = currentState();
			if (!hasMultiAnswer(state)) {
				state.warning = "Select at least one option, type a custom answer, or press Esc to cancel.";
				refresh();
				return;
			}
			state.warning = undefined;
			submitIfComplete(done, questions, states, currentIdx);
			refresh();
		}

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			const question = currentQuestion();
			const state = currentState();
			if (inputMode === "notes") {
				if (noteTarget) {
					if (trimmed) state.notesByOption.set(noteTarget, trimmed);
					else state.notesByOption.delete(noteTarget);
				}
				inputMode = undefined;
				noteTarget = undefined;
				editor.setText("");
				syncEditorFocus();
				refresh();
				return;
			}

			if (inputMode === "custom") {
				if (!trimmed) {
					inputMode = undefined;
					editor.setText("");
					syncEditorFocus();
					refresh();
					return;
				}
				if (question.multiSelect) {
					state.customAnswer = { text: trimmed, selected: true };
					state.optionIndex = question.options.length;
					inputMode = undefined;
					editor.setText("");
					syncEditorFocus();
					refresh();
					return;
				}
				state.singleAnswer = {
					questionIndex: currentIdx,
					question: question.question,
					header: question.header,
					kind: "custom",
					answer: trimmed,
				};
				inputMode = undefined;
				editor.setText("");
				syncEditorFocus();
				submitIfComplete(done, questions, states, currentIdx);
				refresh();
			}
		};

		function handleInput(data: string): void {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					inputMode = undefined;
					noteTarget = undefined;
					editor.setText("");
					syncEditorFocus();
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.left)) {
				setCurrentIdx(previousQuestion(currentIdx, questions.length));
				return;
			}
			if (matchesKey(data, Key.right)) {
				setCurrentIdx(nextQuestion(currentIdx, questions.length));
				return;
			}

			const state = currentState();
			const options = displayOptions(currentQuestion());
			if (matchesKey(data, Key.up)) {
				state.optionIndex = Math.max(0, state.optionIndex - 1);
				clearWarning();
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				state.optionIndex = Math.min(options.length - 1, state.optionIndex + 1);
				clearWarning();
				refresh();
				return;
			}
			if (matchesKey(data, Key.tab)) {
				beginNotesInput();
				return;
			}

			const question = currentQuestion();
			const option = options[state.optionIndex];
			if (question.multiSelect && (data === " " || matchesKey(data, "space"))) {
				if (option?.kind === "other") {
					if (state.customAnswer) {
						state.customAnswer.selected = !state.customAnswer.selected;
						clearWarning();
					} else {
						state.warning = "Press Tab to type a custom answer.";
					}
					refresh();
					return;
				}
				if (option?.kind === "option") {
					if (state.multiSelected.has(option.optionIndex)) state.multiSelected.delete(option.optionIndex);
					else state.multiSelected.add(option.optionIndex);
				}
				clearWarning();
				refresh();
				return;
			}

			if (matchesKey(data, Key.enter)) {
				if (question.multiSelect) {
					recordMulti();
				} else if (option) {
					recordSingle(option);
				}
				return;
			}

			if (matchesKey(data, Key.escape)) {
				done({ answers: orderedAnswers(questions, states), cancelled: true });
			}
		}

		function render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			const lines: string[] = [];
			const renderWidth = Math.max(1, width);
			const question = currentQuestion();
			const state = currentState();
			const options = displayOptions(question);
			const isMulti = question.multiSelect === true;

			function addWrapped(text: string): void {
				lines.push(...wrapTextWithAnsi(text, renderWidth));
			}

			function addWrappedWithPrefix(prefix: string, text: string): void {
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= renderWidth) {
					addWrapped(prefix + text);
					return;
				}
				const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
				const continuationPrefix = " ".repeat(prefixWidth);
				for (let i = 0; i < wrapped.length; i++) {
					lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
				}
			}

			lines.push(theme.fg("accent", "─".repeat(renderWidth)));
			if (questions.length >= 2) {
				const tabs = questions
					.map((q, i) => {
						const answered = hasAnswer(states[i]);
						const label = ` ${answered ? "■" : "□"} ${q.header} `;
						if (i === currentIdx) return theme.bg("selectedBg", theme.fg(answered ? "success" : "text", label));
						return theme.fg(answered ? "success" : "muted", label);
					})
					.join(" ");
				addWrappedWithPrefix(" ", tabs);
				lines.push("");
			}
			addWrappedWithPrefix(" ", `${theme.fg("accent", question.header)}  ${theme.fg("text", question.question)}`);
			lines.push("");

			const optionLines: string[] = [];
			const hasPreview = !isMulti && options.some((o) => o.kind === "option" && o.preview);
			const showPreviewSideBySide = hasPreview && renderWidth >= 60;
			const listWidth = showPreviewSideBySide ? Math.max(20, Math.floor(renderWidth * 0.4)) : renderWidth;

			function addOptionLine(prefix: string, text: string): void {
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= listWidth) {
					optionLines.push(...wrapTextWithAnsi(prefix + text, listWidth));
					return;
				}
				const wrapped = wrapTextWithAnsi(text, listWidth - prefixWidth);
				const cont = " ".repeat(prefixWidth);
				for (let i = 0; i < wrapped.length; i++) {
					optionLines.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
				}
			}

			for (let i = 0; i < options.length; i++) {
				const option = options[i];
				const focused = i === state.optionIndex;
				const checked =
					isMulti &&
					((option.kind === "option" && state.multiSelected.has(option.optionIndex)) ||
						(option.kind === "other" && state.customAnswer?.selected === true));
				const selectedSingle =
					!isMulti &&
					(option.kind === "other" ? state.singleAnswer?.kind === "custom" : state.singleAnswer?.answer === option.label);
				const marker = isMulti
					? option.kind === "other"
						? state.customAnswer
							? checked
								? theme.fg("success", "[x]")
								: theme.fg("dim", "[ ]")
							: "   "
						: checked
							? theme.fg("success", "[x]")
							: theme.fg("dim", "[ ]")
					: "";
				const focusArrow = focused ? theme.fg("accent", "→") : " ";
				const note = option.kind === "option" && state.notesByOption.has(option.label) ? theme.fg("success", " +note") : "";
				const customText =
					option.kind === "other"
						? (state.customAnswer?.text ?? (state.singleAnswer?.kind === "custom" ? state.singleAnswer.answer : undefined))
						: undefined;
				const labelText = customText ? `${option.label}  ✎ ${customText}` : option.label;
				const label = `${i + 1}. ${labelText}${selectedSingle ? " ✓" : ""}${note}`;
				const color = focused ? "accent" : selectedSingle || checked ? "success" : "text";
				addOptionLine(`${focusArrow} ${marker} `, theme.fg(color, label));
				if (option.kind === "option" && option.description) addOptionLine("       ", theme.fg("muted", option.description));
			}

			if (inputMode) {
				optionLines.push("");
				const label = inputMode === "notes" ? `Notes for ${noteTarget ?? "option"}:` : "Your answer:";
				addOptionLine(" ", theme.fg("muted", label));
				for (const line of editor.render(Math.max(1, listWidth - 2))) {
					optionLines.push(` ${line}`);
				}
			}

			if (showPreviewSideBySide) {
				const gap = 2;
				const rightWidth = renderWidth - listWidth - gap;
				const focused = options[state.optionIndex];
				const previewText = focused?.kind === "option" && focused.preview ? focused.preview : "";
				const md = new Markdown(previewText, 1, 0, getMarkdownTheme());
				const rightLines = previewText ? md.render(rightWidth) : [theme.fg("dim", "(no preview)")];
				const maxRows = Math.max(optionLines.length, rightLines.length);
				const pad = " ".repeat(gap);
				for (let r = 0; r < maxRows; r++) {
					const left = r < optionLines.length ? optionLines[r] : "";
					const leftPadded = left + " ".repeat(Math.max(0, listWidth - visibleWidth(left)));
					const right = r < rightLines.length ? rightLines[r] : "";
					lines.push(`${leftPadded}${pad}${right}`);
				}
			} else {
				lines.push(...optionLines);
				if (hasPreview) {
					const focused = options[state.optionIndex];
					const previewText = focused?.kind === "option" && focused.preview ? focused.preview : "";
					if (previewText) {
						lines.push("");
						lines.push(theme.fg("dim", "─".repeat(renderWidth)));
						const md = new Markdown(previewText, 1, 0, getMarkdownTheme());
						lines.push(...md.render(renderWidth));
					}
				}
			}

			lines.push("");
			if (state.warning) {
				addWrappedWithPrefix(" ", theme.fg("warning", state.warning));
				lines.push("");
			}
			if (inputMode === "notes") {
				addWrappedWithPrefix(" ", theme.fg("dim", "Enter to save notes • Esc to go back"));
			} else if (inputMode === "custom") {
				const hint = isMulti ? "Enter to save custom answer • Esc to go back" : "Enter to submit • Esc to go back";
				addWrappedWithPrefix(" ", theme.fg("dim", hint));
			} else if (isMulti) {
				addWrappedWithPrefix(
					" ",
					theme.fg("dim", "Space to toggle • Tab for notes/custom • Enter to submit • ←/→ questions • Esc to cancel"),
				);
			} else {
				addWrappedWithPrefix(
					" ",
					theme.fg("dim", "Tab for notes/custom • Enter to submit answer • ←/→ questions • Esc to cancel"),
				);
			}
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			get focused() {
				return dialogFocused;
			},
			set focused(value: boolean) {
				dialogFocused = value;
				syncEditorFocus();
			},
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	};
}
