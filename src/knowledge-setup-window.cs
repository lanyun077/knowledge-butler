using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Windows' built-in .NET UI; all filesystem and connection changes use the shared Node implementation.
class KnowledgeSetupWindow : Form {
    readonly string node, entry, config;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    RadioButton existing, create;
    TextBox location, name;
    Label locationLabel, nameLabel, status;
    Button browse, save;
    bool busy, completed;
    string existingLocation = "", newLocation = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);

    [STAThread] static void Main(string[] args) {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (args.Length != 3) { MessageBox.Show("请从运行目录的“设置知识库”入口打开。", "知识管家"); return; }
        Application.Run(new KnowledgeSetupWindow(args[0], args[1], args[2]));
    }
    KnowledgeSetupWindow(string node, string entry, string config) {
        this.node = node; this.entry = entry; this.config = config;
        SuspendLayout();
        Font = new Font("Microsoft YaHei UI", 11);
        Text = "知识管家 · 设置知识库"; ClientSize = new Size(640, 424);
        StartPosition = FormStartPosition.CenterScreen; FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; BackColor = Color.FromArgb(245, 247, 250); ForeColor = Color.FromArgb(35, 43, 55);
        var accent = new Panel { BackColor = Color.FromArgb(78, 111, 148) }; accent.SetBounds(32, 32, 4, 32); Controls.Add(accent);
        AddLabel("设置知识库", 48, 24, 560, 22).Height = 44;
        existing = new RadioButton { Text = "使用已有知识库", Checked = true }; existing.SetBounds(32, 88, 232, 36); Controls.Add(existing);
        create = new RadioButton { Text = "新建知识库" }; create.SetBounds(288, 88, 232, 36); Controls.Add(create);
        locationLabel = AddLabel("知识库位置", 32, 144, 576, 11);
        location = AddField(32, 176, 444, "知识库位置");
        browse = new Button { Text = "选择文件夹", FlatStyle = FlatStyle.Flat }; browse.SetBounds(492, 172, 116, 40);
        browse.FlatAppearance.BorderColor = Color.FromArgb(212, 212, 212); Controls.Add(browse);
        browse.Click += delegate { var selected = ChooseFolder(create.Checked ? "选择新知识库的存放位置" : "选择已有 Obsidian 知识库", location.Text);
            if (selected != null) { location.Text = selected; status.Text = ""; } };
        nameLabel = AddLabel("知识库名称", 32, 232, 576, 11); nameLabel.Visible = false;
        name = AddField(32, 264, 576, "知识库名称"); name.Visible = false;
        status = AddLabel("", 32, 328, 376, 11); status.Height = 64; status.AccessibleName = "设置结果";
        save = new Button { Text = "接入知识库", FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(49, 73, 101), ForeColor = Color.White };
        save.FlatAppearance.BorderSize = 0; save.SetBounds(432, 344, 176, 44); Controls.Add(save); AcceptButton = save;
        try { location.Text = (string)InvokeSetup("state", null)["directory"]; }
        catch (Exception error) { status.Text = error.Message; }
        existingLocation = location.Text;
        create.CheckedChanged += delegate {
            if (create.Checked) { existingLocation = location.Text; location.Text = newLocation; }
            else { newLocation = location.Text; location.Text = existingLocation; }
            name.Visible = nameLabel.Visible = create.Checked;
            locationLabel.Text = location.AccessibleName = create.Checked ? "存放位置" : "知识库位置";
            save.Text = create.Checked ? "创建并接入" : "接入知识库";
            status.Text = "";
        };
        save.Click += Save;
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if (busy) e.Cancel = true; };
        AutoScaleDimensions = new SizeF(96, 96); AutoScaleMode = AutoScaleMode.Dpi;
        ResumeLayout(true);
    }
    Label AddLabel(string text, int x, int y, int width, int size) {
        var label = new Label { Text = text, Font = new Font("Microsoft YaHei UI", size) };
        label.SetBounds(x, y, width, 28); Controls.Add(label); return label;
    }
    TextBox AddField(int x, int y, int width, string accessibleName) {
        var field = new TextBox { AccessibleName = accessibleName, BackColor = Color.White };
        field.SetBounds(x, y, width, 32); Controls.Add(field); return field;
    }
    string ChooseFolder(string title, string initial) {
        using (var dialog = new FolderBrowserDialog { Description = title, ShowNewFolderButton = true }) {
            if (Directory.Exists(initial)) dialog.SelectedPath = initial;
            return dialog.ShowDialog(this) == DialogResult.OK ? dialog.SelectedPath : null;
        }
    }
    Dictionary<string, object> InvokeSetup(string command, object payload) {
        var info = new ProcessStartInfo(node, "\"" + entry + "\" --config \"" + config + "\" " + command) {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        using (var process = Process.Start(info)) {
            var output = process.StandardOutput.ReadToEndAsync(); var errors = process.StandardError.ReadToEndAsync();
            if (payload != null) { byte[] bytes = new UTF8Encoding(false).GetBytes(json.Serialize(payload)); process.StandardInput.BaseStream.Write(bytes, 0, bytes.Length); }
            process.StandardInput.Close();
            while (!process.WaitForExit(50)) Application.DoEvents();
            if (process.ExitCode != 0) throw new Exception(errors.Result.Trim());
            return json.Deserialize<Dictionary<string, object>>(output.Result);
        }
    }
    void Save(object sender, EventArgs e) {
        if (completed) { Close(); return; } if (busy) return;
        var payload = new { mode = create.Checked ? "create" : "existing", directory = location.Text.Trim(), name = name.Text.Trim() };
        busy = true; existing.Enabled = create.Enabled = browse.Enabled = save.Enabled = false;
        location.ReadOnly = name.ReadOnly = true; status.Text = "正在设置…";
        try {
            var result = InvokeSetup("apply", payload); location.Text = (string)result["directory"];
            status.Text = "已接入知识库\n重启 Codex 后生效"; completed = true; save.Text = "完成";
        } catch (Exception error) { status.Text = error.Message; }
        finally {
            busy = false; save.Enabled = true;
            existing.Enabled = create.Enabled = browse.Enabled = !completed;
            location.ReadOnly = name.ReadOnly = completed;
        }
    }
}
