import { App, Plugin, PluginSettingTab, Setting, TFile, normalizePath, Notice, moment, MarkdownView } from 'obsidian';

interface WeeklyNotesSettings {
    folder: string;
    template: string;
    dateFormat: string;
}

const DEFAULT_SETTINGS: WeeklyNotesSettings = {
    folder: '',
    template: '',
    dateFormat: 'gggg-[W]ww'
}

export default class WeeklyNotesPlugin extends Plugin {
    settings: WeeklyNotesSettings;

    async onload() {
        await this.loadSettings();

        this.addSettingTab(new WeeklyNotesSettingTab(this.app, this));

        this.addRibbonIcon('calendar-days', 'Open Weekly Note', (evt: MouseEvent) => {
            this.openWeeklyNote();
        });

        this.registerObsidianProtocolHandler("weekly", (params) => {
            this.openWeeklyNote();
        });

        this.addCommand({
            id: 'open-weekly-note',
            name: 'Open Weekly Note',
            callback: () => this.openWeeklyNote(),
        });

        this.registerEvent(
            this.app.vault.on('create', async (file) => {
                if (!(file instanceof TFile) || file.extension !== 'md' || file.stat.size > 0) {
                    return;
                }

                // @ts-ignore
                const dailyNotesPlugin = this.app.internalPlugins?.getPluginById('daily-notes');
                if (dailyNotesPlugin && dailyNotesPlugin.enabled) {
                    // @ts-ignore
                    const settings = dailyNotesPlugin.instance.options;
                    const dailyFormat = settings.format || 'YYYY-MM-DD';
                    const dailyFolder = settings.folder || '';
                    const templatePath = settings.template;

                    if (!templatePath) return;

                    const date = moment(file.basename, dailyFormat, true);
                    if (!date.isValid()) return;

                    // strict folder check
                    if (dailyFolder) {
                        const normalizedDailyFolder = normalizePath(dailyFolder);
                        if (!file.parent || file.parent.path !== normalizedDailyFolder) {
                            return;
                        }
                    }

                    // It matches a daily note! Apply template.
                    const templateFile = this.app.vault.getAbstractFileByPath(normalizePath(templatePath + '.md')) ||
                        this.app.vault.getAbstractFileByPath(normalizePath(templatePath));

                    if (templateFile && templateFile instanceof TFile) {
                        // @ts-ignore
                        const templatesPlugin = this.app.internalPlugins?.getPluginById('templates');
                        if (templatesPlugin && templatesPlugin.enabled) {
                            console.log("Auto-applying Daily Note template to", file.path);
                            // Wait a bit for file to be ready?
                            setTimeout(async () => {
                                // @ts-ignore
                                await templatesPlugin.instance.insertTemplate(templateFile);
                            }, 200);
                        }
                    }
                }
            })
        );
    }

    async openWeeklyNote() {
        try {
            const date = moment();
            const filename = date.format(this.settings.dateFormat);
            const folder = this.settings.folder;
            const normalizedFolder = normalizePath(folder);
            const path = normalizePath(`${folder}/${filename}.md`);

            console.log(`Open Weekly Note: Trying to open/create ${path}`);

            let file = this.app.vault.getAbstractFileByPath(path);
            let created = false;

            if (!file) {
                // Ensure folder exists
                if (normalizedFolder && normalizedFolder !== '/') {
                    const folderExists = this.app.vault.getAbstractFileByPath(normalizedFolder);
                    if (!folderExists) {
                        try {
                            await this.app.vault.createFolder(normalizedFolder);
                        } catch (e) {
                            // Ignore "Folder already exists" if it raced or if createFolder behaved unexpectedly
                            console.warn("Folder creation error (might already exist):", e);
                        }
                    }
                }

                // Create empty file
                file = await this.app.vault.create(path, '');
                created = true;
                new Notice(`Created weekly note: ${filename}`);
            }

            if (file instanceof TFile) {
                const leaf = this.app.workspace.getLeaf(false);
                await leaf.openFile(file);

                // Apply template if configured and file was just created
                if (created && this.settings.template) {
                    let templatePath = normalizePath(this.settings.template);
                    let templateFile = this.app.vault.getAbstractFileByPath(templatePath);

                    if (!templateFile) {
                        templatePath = normalizePath(`${this.settings.template}.md`);
                        templateFile = this.app.vault.getAbstractFileByPath(templatePath);
                    }

                    if (templateFile instanceof TFile) {
                        // @ts-ignore
                        const templatesPlugin = this.app.internalPlugins?.getPluginById('templates');
                        if (templatesPlugin && templatesPlugin.enabled) {
                            console.log("Delegating to Core Templates plugin");
                            // @ts-ignore
                            await templatesPlugin.instance.insertTemplate(templateFile);
                        } else {
                            // Fallback to manual content read if Templates plugin is disabled (or we can't find it)
                            const content = await this.app.vault.read(templateFile);
                            this.app.vault.modify(file, content);
                            new Notice("Core Templates plugin not enabled. Applied raw template.");
                        }

                        // Use Editor to replace content to avoid race conditions with core Templates
                        // We wait a tick to ensure Templates plugin has finished its insertion (if async/debounced)
                        setTimeout(async () => {
                            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                            if (view) {
                                const editor = view.editor;
                                let content = editor.getValue();
                                let modified = false;
                                const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

                                content = content.replace(/!{{(sunday|monday|tuesday|wednesday|thursday|friday|saturday):(.[^}]*)}}/gi, (match, dayName, format) => {
                                    modified = true;
                                    const dayIndex = days.indexOf(dayName.toLowerCase());
                                    if (dayIndex !== -1) {
                                        // Clone the date of the weekly note
                                        const targetDate = date.clone().day(dayIndex);

                                        if (format.trim() === 'daily-note') {
                                            // @ts-ignore
                                            const dailyNotesPlugin = this.app.internalPlugins?.getPluginById('daily-notes');
                                            if (dailyNotesPlugin && dailyNotesPlugin.enabled) {
                                                // @ts-ignore
                                                const settings = dailyNotesPlugin.instance.options;
                                                const dailyFormat = settings.format || 'YYYY-MM-DD';
                                                const dailyFolder = settings.folder || '';

                                                const dateString = targetDate.format(dailyFormat);
                                                if (dailyFolder) {
                                                    return `${dailyFolder}/${dateString}`;
                                                }
                                                return dateString;
                                            } else {
                                                // Fallback if Daily Notes plugin is disabled
                                                return targetDate.format('YYYY-MM-DD');
                                            }
                                        }

                                        return targetDate.format(format);
                                    }
                                    return match;
                                });

                                if (modified) {
                                    editor.setValue(content);
                                    console.log("Weekly Notes: Applied custom date placeholders.");
                                }
                            }
                        }, 100);
                    } else {
                        new Notice(`Template file not found: ${this.settings.template}`);
                    }
                }
            }
        } catch (error) {
            new Notice(`Failed to open weekly note: ${error}`);
            console.error(error);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

class WeeklyNotesSettingTab extends PluginSettingTab {
    plugin: WeeklyNotesPlugin;

    constructor(app: App, plugin: WeeklyNotesPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        containerEl.createEl('h2', { text: 'Weekly Notes Settings' });

        new Setting(containerEl)
            .setName('Note Folder')
            .setDesc('Folder where weekly notes will be created')
            .addText(text => text
                .setPlaceholder('Example: Weekly Notes')
                .setValue(this.plugin.settings.folder)
                .onChange(async (value) => {
                    this.plugin.settings.folder = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Template file')
            .setDesc('Path to the template file (e.g. Templates/Weekly)')
            .addText(text => text
                .setPlaceholder('Example: Templates/Weekly')
                .setValue(this.plugin.settings.template)
                .onChange(async (value) => {
                    this.plugin.settings.template = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Date format')
            .setDesc('Format for the weekly note filename')
            .addText(text => text
                .setPlaceholder('Example: gggg-[W]ww')
                .setValue(this.plugin.settings.dateFormat)
                .onChange(async (value) => {
                    this.plugin.settings.dateFormat = value;
                    await this.plugin.saveSettings();
                }));
    }
}
