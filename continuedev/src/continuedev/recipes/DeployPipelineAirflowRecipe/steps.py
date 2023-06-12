import os
import subprocess
from textwrap import dedent
import time

from ...steps.core.core import WaitForUserInputStep
from ...models.main import Range
from ...models.filesystem import RangeInFile
from ...steps.main import MessageStep
from ...core.sdk import Models
from ...core.observation import DictObservation, InternalErrorObservation
from ...models.filesystem_edit import AddFile, FileEdit
from ...core.main import Step
from ...core.sdk import ContinueSDK
from ...steps.find_and_replace import FindAndReplaceStep

AI_ASSISTED_STRING = "(✨ AI-Assisted ✨)"


class SetupPipelineStep(Step):
    hide: bool = True
    name: str = "Setup dlt Pipeline"

    source_name: str

    async def describe(self, models: Models):
        pass

    async def run(self, sdk: ContinueSDK):
        await sdk.run([
            'python3 -m venv env',
            'source env/bin/activate',
            'pip install dlt',
            f'dlt --non-interactive init {self.source_name} duckdb',
            'pip install -r requirements.txt'
        ], description=dedent(f"""\
            Running the following commands:
            - `python3 -m venv env`: Create a Python virtual environment
            - `source env/bin/activate`: Activate the virtual environment
            - `pip install dlt`: Install dlt
            - `dlt init {self.source_name} duckdb`: Create a new dlt pipeline called {self.source_name} that loads data into a local DuckDB instance
            - `pip install -r requirements.txt`: Install the Python dependencies for the pipeline"""), name="Setup Python environment")


class DeployAirflowStep(Step):
    hide: bool = True
    source_name: str

    async def run(self, sdk: ContinueSDK):

        # Run dlt command to deploy pipeline to Airflow
        await sdk.run([
            f'dlt --non-interactive deploy {self.source_name}_pipeline.py airflow-composer',
        ], description="Running `dlt deploy airflow` to deploy the dlt pipeline to Airflow", name="Deploy dlt pipeline to Airflow")

        # Modify the DAG file
        directory = await sdk.ide.getWorkspaceDirectory()
        filepath = os.path.join(
            directory, f"dags/dag_{self.source_name}_pipeline.py")

        # Replace the pipeline name and dataset name
        await sdk.run_step(FindAndReplaceStep(filepath=filepath, pattern="'pipeline_name'", replacement=f"'{self.source_name}_pipeline'"))
        await sdk.run_step(FindAndReplaceStep(filepath=filepath, pattern="'dataset_name'", replacement=f"'{self.source_name}_data'"))
        await sdk.run_step(FindAndReplaceStep(filepath=filepath, pattern="pipeline_or_source_script", replacement=f"{self.source_name}_pipeline"))

        # Prompt the user for the DAG schedule
        edit_dag_range = Range.from_shorthand(18, 0, 23, 0)
        await sdk.ide.highlightCode(range_in_file=RangeInFile(filepath=filepath, range=edit_dag_range), color="#33993333")
        response = await sdk.run_step(WaitForUserInputStep(prompt="When would you like this Airflow DAG to run? (e.g. every day, every Monday, every 1st of the month, etc.)"))
        await sdk.edit_file(filepath, prompt=f"Edit the DAG so that it runs at the following schedule: '{response.text}'",
                            range=edit_dag_range)

        # Tell the user to check the schedule and fill in owner, email, other default_args
        await sdk.run_step(MessageStep(message="Fill in the owner, email, and other default_args in the DAG file with your own personal information.", name="Fill in default_args"))

        # Run the DAG locally ??
