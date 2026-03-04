# Flutter Fix Missing Types

A VSCode extension that automatically fixes missing generic type annotations in Dart/Flutter projects.

## Features

Automatically fixes `always_specify_types` lint warnings by inserting inferred generic type annotations:

- **Fix Current File** - Fix all missing types in the active Dart file
- **Fix Entire Project** - Scan and fix missing types across all Dart files in your Flutter project

## How It Works

The extension leverages VSCode's built-in diagnostic API to locate `always_specify_types` warnings, then uses the Dart language server's hover information to extract the inferred generic types and automatically inserts them into your code.

### Before

```dart
final bloc = MyBloc(); // ❌ always_specify_types warning
final items = List();   // ❌ missing type argument
```

### After

```dart
final bloc = MyBloc<MyEvent, MyState>(); // ✅ Fixed
final items = List<String>();            // ✅ Fixed
```

## Requirements

- [Dart extension for VSCode](https://marketplace.visualstudio.com/items?itemName=Dart-Code.dart-code) (required for diagnostics)
- Flutter/Dart SDK
- `always_specify_types` lint rule enabled in your `analysis_options.yaml`

## Usage

### Command Palette

1. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Select one of:
   - `Dart: Auto-Fix Missing Types (Current File)`
   - `Dart: Auto-Fix Missing Types (Whole Project)`

### Output

The extension writes detailed logs to the **Dart Generic Auto-Fix** output channel, showing:
- Number of diagnostics found
- Successful fixes with file locations
- Skipped items with reasons

## How It Differs from `dart fix --apply`

The standard `dart fix --apply` command cannot fix `always_specify_types` warnings because the Dart analyzer doesn't provide automated fixes for this lint rule. This extension bridges that gap by:

1. Using the Dart extension's real-time diagnostics (no subprocess overhead)
2. Extracting inferred types from hover information
3. Applying targeted edits to insert the missing types

## Configuration

No configuration required. The extension works out of the box with any Flutter/Dart project that has the Dart extension installed.

## Known Issues

- Only fixes simple generic types (e.g., `List<String>`, `Map<K, V>`)
- Complex nested generics may not be parsed correctly
- Requires the Dart extension to have analyzed the file (open the file first if needed)

## License

MIT
