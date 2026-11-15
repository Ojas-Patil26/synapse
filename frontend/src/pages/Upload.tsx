// Upload Course: name + 1-5 files -> presign + PUT each -> POST /courses ->
// poll GET /courses/:courseId every 2 s -> Home on "ready". Copy is verbatim from COPY.md.
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiRequestError, contentTypeOf, uploadFile } from "../api";
import { ALLOWED_UPLOAD_TYPES, MAX_FILES_PER_COURSE, MAX_UPLOAD_BYTES } from "../contracts";
import { MAX_SEMESTER_LENGTH } from "../contracts";
import { semesterOptions } from "../lib/semester";
import { ALL, useData } from "../state/data";

const POLL_MS = 2000;
const FAILED_COPY = "We couldn't build a map from those files. Check that the notes are readable, then try again.";

type Phase = { name: "form" } | { name: "uploading"; done: number; total: number } | { name: "processing" };

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function Upload() {
  const { graphs, loadGraph, reset } = useData();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [semester, setSemester] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<{ name?: string; files?: string; submit?: string }>({});
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    void loadGraph(ALL).catch(() => undefined);
    return () => {
      live.current = false; // stops the poll loop when the page is left
    };
  }, [loadGraph]);

  const hasCourses = (graphs[ALL]?.courses.length ?? 0) > 0;
  const semesters = semesterOptions(graphs[ALL]?.courses ?? []);

  const addFiles = (incoming: File[]) => {
    if (!incoming.length) return;
    let message: string | undefined;
    const next = [...files];
    for (const f of incoming) {
      if (!ALLOWED_UPLOAD_TYPES.notes.includes(contentTypeOf(f))) message = "That file type isn't supported. Use PDF, PNG, JPG, TXT or MD.";
      else if (f.size > MAX_UPLOAD_BYTES) message = "That file is over 10 MB.";
      else if (next.some((x) => x.name === f.name && x.size === f.size)) continue;
      else if (next.length >= MAX_FILES_PER_COURSE) message = `You can add up to ${MAX_FILES_PER_COURSE} files.`;
      else next.push(f);
    }
    setFiles(next);
    setErrors((e) => ({ ...e, files: message, submit: undefined }));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (phase.name === "form") addFiles(Array.from(e.dataTransfer.files));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const found: typeof errors = {};
    if (!name.trim()) found.name = "Enter a course name.";
    if (files.length === 0) found.files = "Add at least one file.";
    setErrors(found);
    if (found.name || found.files) return;

    try {
      setPhase({ name: "uploading", done: 0, total: files.length });
      const s3Keys: string[] = [];
      for (let i = 0; i < files.length; i++) {
        s3Keys.push(await uploadFile(api, files[i], "notes"));
        if (!live.current) return;
        setPhase({ name: "uploading", done: i + 1, total: files.length });
      }
      const { course } = await api.createCourse({ name: name.trim(), semester: semester.trim() || null, s3Keys });
      if (!live.current) return;
      setPhase({ name: "processing" });

      let status = course.status;
      let misses = 0;
      while (status === "processing") {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (!live.current) return;
        try {
          status = (await api.getCourse(course.id)).course.status;
          misses = 0;
        } catch (err) {
          // One dropped poll should not lose a build that is still running.
          if (++misses >= 5) throw err;
        }
      }
      if (!live.current) return;
      if (status === "ready") {
        reset(); // drop cached graphs and Guide so Home shows the new course
        navigate("/app/home", { replace: true });
      } else {
        setPhase({ name: "form" });
        setErrors({ submit: FAILED_COPY });
      }
    } catch (err) {
      if (!live.current) return;
      setPhase({ name: "form" });
      setErrors({ submit: err instanceof ApiRequestError && err.status !== 0 && err.status < 500 ? err.message : FAILED_COPY });
    }
  };

  const busy = phase.name !== "form";

  return (
    <div className="page narrow">
      <h1>{hasCourses ? "Upload a course" : "Upload your first course"}</h1>
      {!hasCourses && <p className="lede">Add your notes and Synapse will build the concept map. Typed or handwritten, PDF or photo.</p>}

      {phase.name === "processing" ? (
        <div className="processing" role="status">
          <span className="spinner spinner-large" aria-hidden="true" />
          <p>Building your map. Reading your notes and finding the concepts can take a minute or two.</p>
          <p className="muted">{name.trim()}</p>
        </div>
      ) : (
        <form className="upload-form" onSubmit={onSubmit} noValidate>
          <label className="field">
            <span>Course name</span>
            <input
              type="text"
              placeholder="e.g. CSE 360"
              value={name}
              disabled={busy}
              maxLength={80}
              aria-invalid={!!errors.name}
              onChange={(e) => {
                setName(e.target.value);
                if (errors.name) setErrors((x) => ({ ...x, name: undefined }));
              }}
            />
            {errors.name && (
              <em className="field-error" role="alert">
                {errors.name}
              </em>
            )}
          </label>

          <div className="field">
            <label htmlFor="semester-input">
              Semester <span className="optional">(optional)</span>
            </label>
            <input
              id="semester-input"
              type="text"
              placeholder="e.g. Fall 2026"
              value={semester}
              disabled={busy}
              maxLength={MAX_SEMESTER_LENGTH}
              autoComplete="off"
              onChange={(e) => setSemester(e.target.value)}
            />
            <div className="chips" role="group" aria-label="Suggested semesters">
              {semesters.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`chip${semester.trim() === s ? " is-on" : ""}`}
                  aria-pressed={semester.trim() === s}
                  disabled={busy}
                  onClick={() => setSemester(semester.trim() === s ? "" : s)}
                >
                  {s}
                </button>
              ))}
            </div>
            <span className="field-hint">Upload every class from a term under the same semester, then filter your map by it.</span>
          </div>

          <div
            className={`dropzone${dragging ? " is-dragging" : ""}${busy ? " is-disabled" : ""}`}
            role="button"
            tabIndex={0}
            aria-label="Click to upload or drag files here"
            onClick={() => !busy && inputRef.current?.click()}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !busy) {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <svg className="folder" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11Z" />
              <path d="M12 16v-5M9.8 13l2.2-2.2 2.2 2.2" strokeLinecap="round" />
            </svg>
            <p className="dz-main">Click to upload or drag files here</p>
            <p className="dz-sub">PDF, PNG, JPG, TXT or MD · up to 5 files, 10 MB each</p>
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                inputRef.current?.click();
              }}
            >
              Choose File
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              accept=".pdf,.png,.jpg,.jpeg,.txt,.md,application/pdf,image/png,image/jpeg,text/plain,text/markdown"
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </div>
          {errors.files && (
            <p className="field-error" role="alert">
              {errors.files}
            </p>
          )}

          {files.length > 0 && (
            <ul className="file-list">
              {files.map((f) => (
                <li key={f.name + f.size}>
                  <span className="file-name">{f.name}</span>
                  <span className="muted">{kb(f.size)}</span>
                  <button
                    type="button"
                    className="icon-btn icon-btn-small"
                    disabled={busy}
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setFiles((list) => list.filter((x) => x !== f))}
                  >
                    <svg width="12" height="12" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                      <path d="M2 2l10 10M12 2 2 12" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {errors.submit && (
            <p className="note note-error" role="alert">
              {errors.submit}
            </p>
          )}

          <button className="btn btn-primary btn-large" type="submit" disabled={busy}>
            {phase.name === "uploading" ? `Uploading ${Math.min(phase.done + 1, phase.total)} of ${phase.total}…` : "Build my map"}
          </button>
        </form>
      )}
    </div>
  );
}
