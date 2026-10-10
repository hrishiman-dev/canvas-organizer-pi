Set organizerShell = CreateObject("WScript.Shell")
Set organizerFiles = CreateObject("Scripting.FileSystemObject")
scriptDirectory = organizerFiles.GetParentFolderName(WScript.ScriptFullName)
launcher = organizerFiles.BuildPath(scriptDirectory, "run-remote.cmd")
organizerShell.Run Chr(34) & launcher & Chr(34), 0, False
