'use strict';
// design-tools.ts - Agent-facing Design Studio tools.
//
// Mirrors the OpenDesign split between the daemon (registry + prompt
// composition) and the runtime: the model gets a small, typed surface for
// "what design knowledge exists", "use it", and "publish the result",
// instead of hand-editing .od JSON or guessing folder names.
//
// Tool permission classes are declared on each tool (`scope`/`sideEffect`)
// and registered with the sentinel in sentinel.js.

const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_KINDS = ['design-systems', 'design-templates', 'skills', 'craft'];

function mkDesignTools(options: any = {}) {
  const design = require('./design.ts');
  const resolveProject = options.projectDir
    ? () => options.projectDir
    : (ctx: any) => ctx?.cwd || null;

  const status = {
    name: 'design_status',
    description: 'Read the active Design Studio project: folder, project metadata, the design system / skill / template / craft rules in force, the current artifact manifest, and which registry roots are being scanned. Call this before changing design settings.',
    parameters: { type: 'object', properties: {} },
    scope: 'project', sideEffect: false,
    async run(_args: any, ctx: any) {
      const projectDir = resolveProject(ctx);
      if (!projectDir) return { ok: false, error: 'No project folder is selected, so there is no design workspace.' };
      const statusInfo = design.designStatus(projectDir);
      // Text bodies stay out of the tool result: they are already injected in
      // the system prompt, and dumping them here would blow the context.
      return {
        ok: true,
        projectDir: statusInfo.projectDir,
        project: statusInfo.projectJson,
        designSystem: statusInfo.activeDesignSystemId || '',
        skill: statusInfo.activeSkillId || '',
        template: statusInfo.activeTemplateId || '',
        craft: statusInfo.activeCraft || [],
        artifact: statusInfo.artifact,
        counts: {
          'design-systems': statusInfo.systems.length,
          skills: statusInfo.skills.length,
          'design-templates': (statusInfo.templates || []).length,
          craft: (statusInfo.craft || []).length,
        },
        roots: statusInfo.roots,
      };
    },
  };

  const registry = {
    name: 'design_registry',
    description: `Inspect the design registries. kind is one of ${REGISTRY_KINDS.join(', ')}. With no id it lists every entry (id, name, description, source root, files). With an id it returns that entry's instruction document, or a named file from the entry folder. Project entries shadow user entries, which shadow bundled ones.`,
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: REGISTRY_KINDS },
        id: { type: 'string', description: 'Entry id to read; omit to list' },
        file: { type: 'string', description: 'Optional file inside the entry folder, defaults to its document' },
      },
      required: ['kind'],
    },
    scope: 'project', sideEffect: false,
    async run(args: any, ctx: any) {
      const projectDir = resolveProject(ctx);
      if (!REGISTRY_KINDS.includes(args.kind)) return { ok: false, error: `kind must be one of ${REGISTRY_KINDS.join(', ')}` };
      if (args.id) {
        const text = design.readRegistryFile(projectDir, args.kind, String(args.id), args.file || '');
        return { ok: true, ...text };
      }
      const entries = design.listRegistry(projectDir, args.kind)
        .map(entry => ({
          id: entry.id, name: entry.name, description: entry.description, source: entry.source,
          files: (entry.files || []).slice(0, 24), renderer: entry.renderer || undefined,
          shadowed: (entry.shadowedSources || []).length ? entry.shadowedSources : undefined,
        }));
      return { ok: true, kind: args.kind, entries, roots: design.registryRoots(projectDir).map((root: any) => `${root.source}: ${root.dir}`) };
    },
  };

  const configure = {
    name: 'design_configure',
    description: 'Set which design system, skill, template and craft rules this project uses, and update project name/kind. Pass only the fields you are changing; an empty string clears one. A template id also scaffolds that template into the project. Selections are persisted to .od/project.json and shape the next prompt.',
    parameters: {
      type: 'object',
      properties: {
        design_system: { type: 'string', description: 'Design-system id from design_registry, or "" for none' },
        skill: { type: 'string', description: 'Skill id, or "" for none' },
        craft: { type: 'array', items: { type: 'string' }, description: 'Craft rule ids to keep active (replaces the current list)' },
        name: { type: 'string' },
        kind: { type: 'string', description: 'prototype | landing | deck | dashboard | app' },
      },
    },
    scope: 'project', sideEffect: true,
    async run(args: any, ctx: any) {
      const projectDir = resolveProject(ctx);
      if (!projectDir) return { ok: false, error: 'No project folder is selected.' };
      const patch: Record<string, any> = {};
      if (typeof args.design_system === 'string') {
        if (args.design_system && !design.findRegistryEntry(projectDir, 'design-systems', args.design_system)) {
          return { ok: false, error: `Unknown design system “${args.design_system}”. List them with design_registry kind=design-systems.` };
        }
        patch.design_system_id = args.design_system;
      }
      if (typeof args.skill === 'string') {
        if (args.skill && !design.findRegistryEntry(projectDir, 'skills', args.skill)) {
          return { ok: false, error: `Unknown skill “${args.skill}”. List them with design_registry kind=skills.` };
        }
        patch.skill_id = args.skill;
      }
      if (Array.isArray(args.craft)) {
        const known = new Set(design.listRegistry(projectDir, 'craft').map((entry: any) => entry.id));
        const unknown = args.craft.filter((id: string) => !known.has(String(id)));
        if (unknown.length) return { ok: false, error: `Unknown craft rule(s): ${unknown.join(', ')}` };
        patch.craft = args.craft.map(String);
      }
      if (typeof args.name === 'string' && args.name.trim()) patch.name = args.name.trim();
      if (typeof args.kind === 'string' && args.kind.trim()) patch.kind = args.kind.trim();
      if (!Object.keys(patch).length) return { ok: false, error: 'Nothing to change. Provide design_system, skill, craft, name or kind.' };
      const project = design.saveDesignProject(projectDir, patch);
      // Pick up the new knowledge immediately for the rest of this run.
      const context = design.designContext(projectDir);
      if (context?.text) ctx.agent?.replaceDesignContext?.(context.text);
      return { ok: true, project, note: 'Saved. New design instructions apply from the next model call.' };
    },
  };

  const scaffold = {
    name: 'design_scaffold',
    description: 'Copy a design template’s starter files into the project folder (landing page, deck, dashboard, …). Existing files are kept unless force is true. Returns the files written and skipped. Use this before building when a registered template matches the request.',
    parameters: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Template id from design_registry kind=design-templates' },
        force: { type: 'boolean', description: 'Overwrite files that already exist, default false' },
      },
      required: ['template'],
    },
    scope: 'project', sideEffect: true,
    async run(args: any, ctx: any) {
      const projectDir = resolveProject(ctx);
      if (!projectDir) return { ok: false, error: 'No project folder is selected.' };
      try {
        const result = design.applyTemplate(projectDir, String(args.template || ''), { force: !!args.force });
        return { ok: true, ...result, projectDir };
      } catch (error: any) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
  };

  const artifact = {
    name: 'design_artifact',
    description: 'Publish the design artifact you just produced so the Design Studio canvas can preview it. Validates that entry exists inside the project and writes .od/artifact.json. kind: html | svg | deck | markdown | react-component | mini-app | document.',
    parameters: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'Project-relative entry file, e.g. index.html' },
        kind: { type: 'string', enum: Array.from(design.ARTIFACT_KINDS) },
        title: { type: 'string' },
        status: { type: 'string', enum: ['streaming', 'complete', 'error'] },
        supporting_files: { type: 'array', items: { type: 'string' } },
      },
      required: ['entry'],
    },
    scope: 'project', sideEffect: true,
    async run(args: any, ctx: any) {
      const projectDir = resolveProject(ctx);
      if (!projectDir) return { ok: false, error: 'No project folder is selected.' };
      const project = design.readProjectJson?.(projectDir) || {};
      try {
        const manifest = design.writeArtifact(projectDir, {
          kind: args.kind, entry: args.entry, title: args.title,
          renderer: args.renderer, status: args.status,
          supportingFiles: Array.isArray(args.supporting_files) ? args.supporting_files : [],
          sourceSkillId: project.skill_id || '', sourceDesignSystemId: project.design_system_id || '',
        });
        return { ok: true, manifest, note: 'The canvas refreshes within a couple of seconds.' };
      } catch (error: any) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
  };

  return [status, registry, configure, scaffold, artifact];
}

const DESIGN_TOOL_NAMES = ['design_status', 'design_registry', 'design_configure', 'design_scaffold', 'design_artifact'];
const DESIGN_READ_NAMES = ['design_status', 'design_registry'];
const DESIGN_WRITE_NAMES = ['design_configure', 'design_scaffold', 'design_artifact'];

module.exports = { mkDesignTools, REGISTRY_KINDS, DESIGN_TOOL_NAMES, DESIGN_READ_NAMES, DESIGN_WRITE_NAMES };
