/**
 * Shell syntax highlighting for the command shown on a bash tool row.
 *
 * A transcript's bash rows are the one place loop prints something the user
 * would normally read in a coloured shell, and they were printed as one flat
 * grey run — so a pipeline of four stages, a quoted path with a space in it,
 * and a stray `&&` all looked the same. Everything else loop shows is
 * highlighted (a read's file, a diff, a fenced block); the command was not.
 *
 * Not highlight.js. Its bash grammar colours shell BUILT-INS and keywords and
 * leaves the command name alone, so `echo` lights up and `git` does not, which
 * is backwards for a row whose whole subject is which program ran. This follows
 * what an interactive shell highlights instead: the command at the head of each
 * pipeline segment, its quoting, its variables, its operators and redirections.
 *
 * Colour comes from the same `syntax*` theme slots the code highlighter uses,
 * so it repaints with the palette and needs no per-theme work. Everything not
 * recognised keeps the caller's base slot, which is what the whole summary used
 * to be — highlighting adds emphasis here, it does not add a second palette.
 */
import { theme, type Theme } from "./theme";

type Slot = Parameters<Theme["fg"]>[0];

/** Words that put the parser back at the head of a command. */
const COMMAND_BREAK = new Set(["|", "||", "&&", ";", "&", "(", ")", "{", "}", "|&", ";;"]);

/**
 * Shell keywords — grammar rather than programs, so they take the keyword slot
 * even though they sit where a command name would.
 *
 * Only recognised AT a command position. `done` and `in` are ordinary words
 * everywhere else, and `echo done` should not paint its argument as the end of
 * a loop that was never opened.
 */
const KEYWORDS = new Set([
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "for",
    "while",
    "until",
    "do",
    "done",
    "case",
    "esac",
    "function",
    "select",
    "time",
    "coproc",
    "!",
]);

/** Keywords after which the next word names a variable, not a command. */
const BINDS_VARIABLE = new Set(["for", "select"]);

/** Keywords after which the next word is a subject, not a command. */
const TAKES_SUBJECT = new Set(["case"]);

/** Operators worth their own colour, longest first so `&&` beats `&`. */
const OPERATORS = ["&&", "||", ">>", "<<", "2>&1", "|&", ";;", "|", ";", "&", ">", "<", "(", ")"];

interface Cursor {
    readonly text: string;
    index: number;
}

function startsWith(cur: Cursor, token: string): boolean {
    return cur.text.startsWith(token, cur.index);
}

/**
 * Read a quoted run, including its closing quote when there is one. An
 * unterminated quote — which a truncated first line often has — runs to the end
 * rather than falling back to per-character colouring.
 */
function readQuoted(cur: Cursor, quote: string): string {
    const start = cur.index;
    cur.index++; // opening quote
    while (cur.index < cur.text.length) {
        const ch = cur.text[cur.index];
        if (ch === "\\" && quote !== "'") {
            cur.index += 2; // an escape inside "" or `` hides the next char
            continue;
        }
        cur.index++;
        if (ch === quote) break;
    }
    return cur.text.slice(start, cur.index);
}

/** Read `$NAME`, `${...}` or `$(...)` — the `$` and what belongs to it. */
function readVariable(cur: Cursor): string {
    const start = cur.index;
    cur.index++; // $
    const next = cur.text[cur.index];
    if (next === "{" || next === "(") {
        const close = next === "{" ? "}" : ")";
        let depth = 1;
        cur.index++;
        while (cur.index < cur.text.length && depth > 0) {
            const ch = cur.text[cur.index++];
            if (ch === next) depth++;
            else if (ch === close) depth--;
        }
    } else {
        while (cur.index < cur.text.length && /[A-Za-z0-9_]/.test(cur.text[cur.index])) cur.index++;
    }
    return cur.text.slice(start, cur.index);
}

/** Read one bare word: everything up to whitespace or a character with meaning. */
function readWord(cur: Cursor): string {
    const start = cur.index;
    while (cur.index < cur.text.length && !/[\s'"`$|;&<>()]/.test(cur.text[cur.index])) cur.index++;
    // A word that touched nothing is still a word — never return "" or the
    // caller loops forever on a character none of the readers claimed.
    if (cur.index === start) cur.index++;
    return cur.text.slice(start, cur.index);
}

/**
 * `command` for a single-line shell command, coloured for a terminal row.
 *
 * `base` is the slot everything unrecognised keeps. Input must be plain text:
 * a summary that already carries escapes (an extension's, say) is returned
 * untouched by the caller rather than re-coloured here.
 */
export function highlightShellCommand(command: string, base: Slot = "muted"): string {
    const cur: Cursor = { text: command, index: 0 };
    let out = "";
    // True at the head of a command — the position where a word is the program
    // being run rather than one of its arguments.
    let atCommand = true;
    // `for x` / `select x`: the word after the keyword binds a name.
    let bindingVariable = false;
    // ...and the `in` after that name is the keyword, not an argument.
    let expectingIn = false;
    const paint = (slot: Slot, text: string): void => {
        out += theme.fg(slot, text);
    };

    while (cur.index < cur.text.length) {
        const ch = cur.text[cur.index];

        if (/\s/.test(ch)) {
            const start = cur.index;
            while (cur.index < cur.text.length && /\s/.test(cur.text[cur.index])) cur.index++;
            out += cur.text.slice(start, cur.index);
            continue;
        }

        // A `#` that opens a word is a comment to end of line.
        if (ch === "#" && (cur.index === 0 || /\s/.test(cur.text[cur.index - 1]))) {
            paint("syntaxComment", cur.text.slice(cur.index));
            break;
        }

        if (ch === "'" || ch === '"' || ch === "`") {
            paint("syntaxString", readQuoted(cur, ch));
            atCommand = false;
            continue;
        }

        if (ch === "$") {
            paint("syntaxVariable", readVariable(cur));
            atCommand = false;
            continue;
        }

        const op = OPERATORS.find((candidate) => startsWith(cur, candidate));
        if (op) {
            cur.index += op.length;
            paint("syntaxOperator", op);
            // After a pipe or a separator the next word runs a program again.
            if (COMMAND_BREAK.has(op)) {
                atCommand = true;
                bindingVariable = false;
                expectingIn = false;
            }
            continue;
        }

        const word = readWord(cur);
        if (bindingVariable) {
            // `for f` — the loop's own name, which is a variable and not a
            // program however much it sits where one would.
            paint("syntaxVariable", word);
            bindingVariable = false;
            expectingIn = true;
            atCommand = false;
        } else if (expectingIn && word === "in") {
            paint("syntaxKeyword", word);
            expectingIn = false;
            atCommand = false; // what follows a loop's `in` is values
        } else if (atCommand && KEYWORDS.has(word)) {
            paint("syntaxKeyword", word);
            bindingVariable = BINDS_VARIABLE.has(word);
            atCommand = !bindingVariable && !TAKES_SUBJECT.has(word);
        } else if (atCommand) {
            // The program being run. An assignment prefix (`FOO=bar cmd`) is
            // not the program, so the next word still gets the slot.
            if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) paint("syntaxVariable", word);
            else {
                paint("syntaxFunction", word);
                atCommand = false;
            }
        } else if (word.startsWith("-")) {
            // Flags recede rather than shout: in a long command they are the
            // part you skim past to find the paths and the pipeline.
            paint("dim", word);
        } else if (/^-?\d+(\.\d+)?$/.test(word)) {
            paint("syntaxNumber", word);
        } else {
            paint(base, word);
        }
    }
    return out;
}
